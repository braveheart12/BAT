'use strict'
import { serial as test } from 'ava'
import uuidV4 from 'uuid/v4'
import {
  cleanDbs,
  cleanPgDb,
  eyeshadeAgent,
  connectToDb,
  braveYoutubePublisher
} from '../utils'
import {
  timeout
} from 'bat-utils/lib/extras-utils'
import { Runtime } from 'bat-utils'

const {
  BAT_REDIS_URL,
  BAT_POSTGRES_URL
} = process.env
const runtime = new Runtime({
  prometheus: {
    label: 'eyeshade.worker.1',
    redis: BAT_REDIS_URL
  },
  postgres: {
    url: BAT_POSTGRES_URL
  }
})
test.afterEach.always(cleanDbs)
test.afterEach.always(cleanPgDb(runtime.postgres))

test('referrals are inserted into mongo then eventually postgres', async t => {
  const eyeshadeMongo = await connectToDb('eyeshade')
  const postgresClient = await runtime.postgres.connect()

  const txId = uuidV4().toLowerCase()
  const referral = {
    downloadId: uuidV4().toLowerCase(),
    channelId: braveYoutubePublisher,
    platform: 'ios',
    finalized: new Date(),
    ownerId: 'publishers#uuid:' + uuidV4().toLowerCase()
  }
  await eyeshadeAgent.put(`/v1/referrals/${txId}`).send([referral]).expect(200)

  // ensure referral docs are created in mongo
  const referralCollection = await eyeshadeMongo.collection('referrals')
  const referralDocs = await referralCollection.find({ downloadId: referral.downloadId }).toArray()
  t.true(referralDocs.length === 1)

  // ensure referral records are created in postgres
  let rows
  do { // wait until referral-report is processed and transactions are entered into postgres
    await timeout(500).then(async () => {
      rows = (await postgresClient.query(`select * from transactions where transaction_type = 'referral'`)).rows
    })
  } while (rows.length === 0)
  t.true(rows.length === 1)
})

test('duplicate referrals will not be inserted into mongo', async t => {
  const eyeshadeMongo = await connectToDb('eyeshade')
  const txId = uuidV4().toLowerCase()
  const referral = {
    downloadId: uuidV4().toLowerCase(),
    channelId: braveYoutubePublisher,
    platform: 'ios',
    finalized: new Date(),
    ownerId: 'publishers#uuid:' + uuidV4().toLowerCase()
  }
  await eyeshadeAgent.put(`/v1/referrals/${txId}`).send([referral]).expect(200)

  // ensure referral docs are created in mongo
  const referralCollection = await eyeshadeMongo.collection('referrals')
  let referralDocs = await referralCollection.find({ downloadId: referral.downloadId }).toArray()
  t.true(referralDocs.length === 1)

  // post the same referral again and ensure no more were created
  await eyeshadeAgent.put(`/v1/referrals/${txId}`).send([referral]).expect(200)
  referralDocs = await referralCollection.find({ downloadId: referral.downloadId }).toArray()
  t.true(referralDocs.length === 1)

  // post the same referral again under different txId but same downloadId and ensure no more were created
  const txId2 = uuidV4().toLowerCase()
  await eyeshadeAgent.put(`/v1/referrals/${txId2}`).send([referral]).expect(200)
  referralDocs = await referralCollection.find({ downloadId: referral.downloadId }).toArray()

  t.true(referralDocs.length === 1)
  t.true(referralDocs[0].transactionId === txId)
})

test('if promo sends mix of duplicate and valid referrals with same tx id, only insert the valid referrals', async t => {
  const eyeshadeMongo = await connectToDb('eyeshade')
  const txId = uuidV4().toLowerCase()
  const referral = {
    downloadId: uuidV4().toLowerCase(),
    channelId: braveYoutubePublisher,
    platform: 'ios',
    finalized: new Date(),
    ownerId: 'publishers#uuid:' + uuidV4().toLowerCase()
  }

  await eyeshadeAgent.put(`/v1/referrals/${txId}`).send([referral]).expect(200)

  const referral2 = {
    downloadId: uuidV4().toLowerCase(),
    channelId: braveYoutubePublisher,
    platform: 'ios',
    finalized: new Date(),
    ownerId: 'publishers#uuid:' + uuidV4().toLowerCase()
  }

  await eyeshadeAgent.put(`/v1/referrals/${txId}`).send([referral, referral2]).expect(200)
  const referralCollection = await eyeshadeMongo.collection('referrals')
  const referralDocs = await referralCollection.find({ transactionId: txId }).toArray()
  t.true(referralDocs.length === 2)
})
