const github = require('@actions/github')
const core = require('@actions/core')
const _ = require('lodash')
const cc = require('@conventional-commits/parser')
const semver = require('semver')

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])
const MAX_RATE_LIMIT_WAIT_MS = 60000

function isRetryable (err) {
  if (err.status && RETRYABLE_STATUS_CODES.has(err.status)) return true
  if (err.message && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(err.message)) return true
  return false
}

// A GraphQL rate limit arrives as HTTP 200 with an errors array, so it has no
// status code to match on.
function isRateLimited (err) {
  const errors = err.errors || (err.response && err.response.errors) || []
  if (errors.some(e => e.type === 'RATE_LIMIT' || e.code === 'graphql_rate_limit')) return true
  return err.status === 403 && /rate limit/i.test(err.message || '')
}

// Milliseconds to wait before retrying a rate-limited request, or null when the
// quota resets too far in the future to be worth waiting for.
function rateLimitWaitMs (err) {
  const headers = err.headers || {}
  const retryAfter = Number(headers['retry-after'])
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
  }
  const reset = Number(headers['x-ratelimit-reset'])
  if (!Number.isFinite(reset)) return null
  const waitMs = reset * 1000 - Date.now() + 1000
  if (waitMs <= 0) return 1000
  return waitMs > MAX_RATE_LIMIT_WAIT_MS ? null : waitMs
}

function rateLimitMessage (err) {
  const headers = err.headers || {}
  const reset = Number(headers['x-ratelimit-reset'])
  const resetAt = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : 'unknown'
  return `GitHub API rate limit exhausted for this installation (${headers['x-ratelimit-used'] || '?'}/${headers['x-ratelimit-limit'] || '?'} on the ${headers['x-ratelimit-resource'] || 'unknown'} resource). Quota resets at ${resetAt}.`
}

async function retryRequest (fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (isRateLimited(err)) {
        const waitMs = attempt === maxRetries ? null : rateLimitWaitMs(err)
        if (waitMs === null) {
          throw new Error(rateLimitMessage(err))
        }
        core.info(`${rateLimitMessage(err)} Waiting ${Math.round(waitMs / 1000)}s before retrying...`)
        await new Promise(resolve => setTimeout(resolve, waitMs))
        continue
      }
      if (attempt === maxRetries || !isRetryable(err)) {
        throw err
      }
      const delay = Math.pow(2, attempt) * 1000
      core.info(`Request failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying in ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

const TAGS_QUERY = `
  query lastTags($owner: String!, $repo: String!, $cursor: String, $nameFilter: String) {
    repository(owner: $owner, name: $repo) {
      refs(
        first: 100
        after: $cursor
        refPrefix: "refs/tags/"
        query: $nameFilter
        orderBy: { field: TAG_COMMIT_DATE, direction: DESC }
      ) {
        nodes {
          name
          target {
            oid
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

// Walks tags newest-first and stops at the first one that matches, so a repo
// with thousands of tags costs one request instead of one per hundred tags.
async function findLatestTag (gh, owner, repo, { prefix, tagFilterRgx, skipInvalidTags, nameFilter }) {
  let cursor = null
  let scanned = 0
  let isFirstCandidate = true

  for (;;) {
    const result = await retryRequest(() => gh.graphql(TAGS_QUERY, { owner, repo, cursor, nameFilter }))
    const refs = result.repository.refs

    for (const tag of refs.nodes) {
      if (prefix && tag.name.indexOf(prefix) !== 0) continue
      const name = prefix ? tag.name.slice(prefix.length) : tag.name
      if (tagFilterRgx && !tagFilterRgx.test(name)) continue

      if (semver.valid(name)) {
        core.info(`Found matching tag after scanning ${scanned + refs.nodes.length} tags`)
        return { name, target: tag.target }
      }
      if (isFirstCandidate && !skipInvalidTags) return null
      isFirstCandidate = false
    }

    scanned += refs.nodes.length
    if (!refs.pageInfo.hasNextPage) {
      core.info(`Scanned ${scanned} tags without a match`)
      return null
    }
    cursor = refs.pageInfo.endCursor
  }
}

async function main () {
  const token = core.getInput('token')
  const branch = core.getInput('branch')
  const gh = github.getOctokit(token)
  const owner = github.context.repo.owner
  const repo = github.context.repo.repo
  const skipInvalidTags = core.getBooleanInput('skipInvalidTags')
  const noVersionBumpBehavior = core.getInput('noVersionBumpBehavior')
  const noNewCommitBehavior = core.getInput('noNewCommitBehavior')
  const prefix = core.getInput('prefix') || ''
  const additionalCommits = core.getInput('additionalCommits').split('\n').map(l => l.trim()).filter(l => l !== '')
  const fromTag = core.getInput('fromTag')
  const fallbackTag = core.getInput('fallbackTag')
  const tagFilter = core.getInput('tagFilter')
  const scopeList = core.getInput('scopeList').split(',').map(s => s.trim()).filter(s => s !== '')

  const bumpTypes = {
    major: core.getInput('majorList').split(',').map(p => p.trim()).filter(p => p),
    minor: core.getInput('minorList').split(',').map(p => p.trim()).filter(p => p),
    patch: core.getInput('patchList').split(',').map(p => p.trim()).filter(p => p),
    patchAll: (core.getInput('patchAll') === true || core.getInput('patchAll') === 'true')
  }

  function outputVersion (version) {
    core.exportVariable('next', `${prefix}v${version}`)
    core.exportVariable('nextStrict', `${prefix}${version}`)

    core.setOutput('next', `${prefix}v${version}`)
    core.setOutput('nextStrict', `${prefix}${version}`)
    core.setOutput('nextMajor', `${prefix}v${semver.major(version)}`)
    core.setOutput('nextMajorStrict', `${prefix}${semver.major(version)}`)
  }

  let latestTag = null

  if (!fromTag) {
    // GET LATEST + PREVIOUS TAGS

    let tagFilterRgx = null
    if (tagFilter) {
      core.info(`Will filter tags based on pattern: ${tagFilter}`)
      tagFilterRgx = new RegExp(tagFilter)
    }

    // Asking the API for only the tags starting with the prefix keeps
    // monorepos with thousands of tags from paging through all of them.
    latestTag = await findLatestTag(gh, owner, repo, { prefix, tagFilterRgx, skipInvalidTags, nameFilter: prefix || null })
    if (!latestTag && prefix) {
      core.info('No match among the prefixed tags; scanning all tags instead.')
      latestTag = await findLatestTag(gh, owner, repo, { prefix, tagFilterRgx, skipInvalidTags, nameFilter: null })
    }

    if (!latestTag) {
      if (fallbackTag && semver.valid(fallbackTag)) {
        core.info(`Using fallback tag: ${fallbackTag}`)
        latestTag = { name: fallbackTag }
      } else {
        if (prefix) {
          return core.setFailed('No tag matches the specified prefix and is valid semver!')
        } else {
          return core.setFailed(skipInvalidTags ? 'None of the tags are valid semver!' : 'Latest tag is invalid (does not conform to semver)!')
        }
      }
    }

    core.info(`Comparing against latest tag: ${prefix}${latestTag.name}`)
  } else {
    // GET SPECIFIC TAG

    const tagRaw = await retryRequest(() => gh.graphql(`
      query singleTag ($owner: String!, $repo: String!, $tag: String!) {
        repository (owner: $owner, name: $repo) {
          ref(qualifiedName: $tag) {
            name
            target {
              oid
            }
          }
        }
      }
    `, {
      owner,
      repo,
      tag: `refs/tags/${prefix}${fromTag}`
    }))

    latestTag = _.get(tagRaw, 'repository.ref')

    if (!latestTag) {
      return core.setFailed('Provided tag could not be found!')
    }
    if (prefix && latestTag.name.indexOf(prefix) === 0) {
      latestTag.name = latestTag.name.replace(prefix, '')
    }
    if (!semver.valid(latestTag.name)) {
      return core.setFailed('Provided tag is invalid! (does not conform to semver)')
    }

    core.info(`Comparing against provided tag: ${prefix}${latestTag.name}`)
  }

  // OUTPUT CURRENT VARS

  core.exportVariable('current', `${prefix}${latestTag.name}`)
  core.setOutput('current', `${prefix}${latestTag.name}`)

  // GET COMMITS

  let curPage = 0
  let totalCommits = 0
  let hasMoreCommits = false
  const commits = []
  do {
    hasMoreCommits = false
    curPage++
    const commitsRaw = await retryRequest(() => gh.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${prefix}${latestTag.name}...${branch}`,
      page: curPage,
      per_page: 100
    }))
    totalCommits = _.get(commitsRaw, 'data.total_commits', 0)
    const rangeCommits = _.get(commitsRaw, 'data.commits', [])
    commits.push(...rangeCommits)
    if ((curPage - 1) * 100 + rangeCommits.length < totalCommits) {
      hasMoreCommits = true
    }
  } while (hasMoreCommits)

  if (additionalCommits && additionalCommits.length > 0) {
    commits.push(...additionalCommits.map(ac => ({ commit: { message: ac }, sha: 'unknown' })))
  }

  if (!commits || commits.length < 1) {
    switch (noNewCommitBehavior) {
      case 'current': {
        core.info('Couldn\'t find any commits between branch HEAD and latest tag. Exiting with current as next version...')
        outputVersion(semver.clean(latestTag.name))
        return
      }
      case 'silent': {
        return core.info('Couldn\'t find any commits between branch HEAD and latest tag. Exiting silently...')
      }
      case 'warn': {
        return core.warning('Couldn\'t find any commits between branch HEAD and latest tag.')
      }
      default: {
        return core.setFailed('Couldn\'t find any commits between branch HEAD and latest tag.')
      }
    }
  }

  // PARSE COMMITS

  const majorChanges = []
  const minorChanges = []
  const patchChanges = []
  for (const commit of commits) {
    try {
      const cAst = cc.toConventionalChangelogFormat(cc.parser(commit.commit.message))

      if (scopeList && scopeList.length > 0) {
        const commitScope = (cAst.scope || '').toString()
        if (commitScope.length > 0) {
          if (!scopeList.includes(commitScope)) {
            core.info(`[SKIP] Commit ${commit.sha} has scope '${commitScope}', which does not match allowed scopes: ${scopeList.join(', ')}.`)
            continue
          }
        } else {
          core.info(`[SKIP] Commit ${commit.sha} has no scope and will be excluded as scopeList is defined.`)
          continue
        }
      }

      if (bumpTypes.major.includes(cAst.type)) {
        majorChanges.push(commit.commit.message)
        core.info(`[MAJOR] Commit ${commit.sha} of type ${cAst.type} will cause a major version bump.`)
      } else if (bumpTypes.minor.includes(cAst.type)) {
        minorChanges.push(commit.commit.message)
        core.info(`[MINOR] Commit ${commit.sha} of type ${cAst.type} will cause a minor version bump.`)
      } else if (bumpTypes.patchAll || bumpTypes.patch.includes(cAst.type)) {
        patchChanges.push(commit.commit.message)
        core.info(`[PATCH] Commit ${commit.sha} of type ${cAst.type} will cause a patch version bump.`)
      } else {
        core.info(`[SKIP] Commit ${commit.sha} of type ${cAst.type} will not cause any version bump.`)
      }
      for (const note of cAst.notes) {
        if (note.title === 'BREAKING CHANGE') {
          majorChanges.push(commit.commit.message)
          core.info(`[MAJOR] Commit ${commit.sha} has a BREAKING CHANGE mention, causing a major version bump.`)
        }
      }
    } catch (err) {
      core.info(`[INVALID] Skipping commit ${commit.sha} as it doesn't follow conventional commit format.`)
    }
  }

  let bump = null
  if (majorChanges.length > 0) {
    bump = 'major'
  } else if (minorChanges.length > 0) {
    bump = 'minor'
  } else if (patchChanges.length > 0) {
    bump = 'patch'
  } else {
    switch (noVersionBumpBehavior) {
      case 'current': {
        core.info('No commit resulted in a version bump since last release! Exiting with current as next version...')
        outputVersion(semver.clean(latestTag.name))
        break
      }
      case 'patch': {
        core.info('No commit resulted in a version bump since last release! Defaulting to using PATCH...')
        bump = 'patch'
        break
      }
      case 'silent': {
        core.info('No commit resulted in a version bump since last release! Exiting silently...')
        break
      }
      case 'warn': {
        core.warning('No commit resulted in a version bump since last release!')
        break
      }
      default: {
        core.setFailed('No commit resulted in a version bump since last release!')
        break
      }
    }
  }

  core.setOutput('bump', bump || 'none')
  if (!bump) {
    return
  }

  core.info(`\n>>> Will bump version ${prefix}${latestTag.name} using ${bump.toUpperCase()}\n`)

  // BUMP VERSION

  const next = semver.inc(latestTag.name, bump)

  core.info(`Current version is ${prefix}${latestTag.name}`)
  core.info(`Next version is ${prefix}v${next}`)

  outputVersion(next)
}

main().catch(err => {
  core.setFailed(err.message)
})
