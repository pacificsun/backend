const uuidv4 = require('uuid/v4')

const cognito = require('../../utils/cognito')
const {mutations, queries} = require('../../schema')
const loginCache = new cognito.AppSyncLoginCache()
jest.retryTimes(2)

beforeAll(async () => {
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
  loginCache.addCleanLogin(await cognito.getAppSyncLogin())
})

beforeEach(async () => await loginCache.clean())
afterAll(async () => await loginCache.reset())

/* Waring: I don't play well with the other tests.
 *
 * We don't want a user with username 'real' to be present in the DB while the other
 * tests run, because all new & reset'd users will auto-follow them, throwing off the
 * expected state (number of followed, number of posts in feed, etc).
 *
 * As such, running this test in parrallel with other tests can cause the other tests
 * to mitakenly fail.
 *
 * Note that in the backend this depends on some user id's that are cached in-memory in
 * the lambda handler, so this test may mistakenly fail if run after other tests. Best
 * to run it right after doing a 'serverless deploy', which creates a new version of the
 * lambda handlers thus clearing the in-memory caches.
 */

test('If the `real` or `ian` users flag a post, it should be immediately archived', async () => {
  const {client: ourClient} = await loginCache.getCleanLogin()
  const {client: randoClient} = await loginCache.getCleanLogin()

  // set the ian user's username to 'ian'
  const {client: ianClient} = await loginCache.getCleanLogin()
  await ianClient.mutate({mutation: mutations.setUsername, variables: {username: 'ian'}})

  // set the real user's username to 'real'
  // note this one is done last so other users don't auto-follow them
  const {client: realClient} = await loginCache.getCleanLogin()
  await realClient.mutate({mutation: mutations.setUsername, variables: {username: 'real'}})

  // We add three posts
  const [postId1, postId2, postId3] = [uuidv4(), uuidv4(), uuidv4()]
  let variables = {postType: 'TEXT_ONLY', text: 'this is really ofensive'}
  let resp
  resp = await ourClient.mutate({mutation: mutations.addPost, variables: {...{postId: postId1}, ...variables}})
  expect(resp.data.addPost.postId).toBe(postId1)
  expect(resp.data.addPost.postStatus).toBe('COMPLETED')
  resp = await ourClient.mutate({mutation: mutations.addPost, variables: {...{postId: postId2}, ...variables}})
  expect(resp.data.addPost.postId).toBe(postId2)
  expect(resp.data.addPost.postStatus).toBe('COMPLETED')
  resp = await ourClient.mutate({mutation: mutations.addPost, variables: {...{postId: postId3}, ...variables}})
  expect(resp.data.addPost.postId).toBe(postId3)
  expect(resp.data.addPost.postStatus).toBe('COMPLETED')

  // the real user flags the first post
  resp = await realClient.mutate({mutation: mutations.flagPost, variables: {postId: postId1}})
  expect(resp.data.flagPost.postId).toBe(postId1)
  expect(resp.data.flagPost.postStatus).toBe('COMPLETED') // archiving happens asyncronously
  expect(resp.data.flagPost.flagStatus).toBe('FLAGGED')

  // the ian user flags the second post
  resp = await ianClient.mutate({mutation: mutations.flagPost, variables: {postId: postId2}})
  expect(resp.data.flagPost.postId).toBe(postId2)
  expect(resp.data.flagPost.postStatus).toBe('COMPLETED') // archiving happens asyncronously
  expect(resp.data.flagPost.flagStatus).toBe('FLAGGED')

  // a rando user flags the third post
  resp = await randoClient.mutate({mutation: mutations.flagPost, variables: {postId: postId3}})
  expect(resp.data.flagPost.postId).toBe(postId3)
  expect(resp.data.flagPost.postStatus).toBe('COMPLETED')
  expect(resp.data.flagPost.flagStatus).toBe('FLAGGED')

  // check the first post is really archived
  resp = await ourClient.query({query: queries.post, variables: {postId: postId1}})
  expect(resp.data.post.postId).toBe(postId1)
  expect(resp.data.post.postStatus).toBe('ARCHIVED')

  // check the second post is really archived
  resp = await ourClient.query({query: queries.post, variables: {postId: postId2}})
  expect(resp.data.post.postId).toBe(postId2)
  expect(resp.data.post.postStatus).toBe('ARCHIVED')

  // check the third post is not archived
  resp = await ourClient.query({query: queries.post, variables: {postId: postId3}})
  expect(resp.data.post.postId).toBe(postId3)
  expect(resp.data.post.postStatus).toBe('COMPLETED')
})
