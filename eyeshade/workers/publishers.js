const { insertFromSettlement } = require('../lib/transaction.js')

exports.name = 'publishers'
exports.initialize = async (debug, runtime) => {
  await runtime.queue.create('settlement-report')
}

exports.workers = {
/* sent by POST /v2/publishers/settlement

    { queue   : 'settlement-report'
    , message :
      { settlementId         : '',
        type                 : '',
      }
    }
*/
  'settlement-report':
    async (debug, runtime, payload) => {
      const settlementsCollection = runtime.database.get('settlements', debug)
      const {
        settlementId,
        type
      } = payload

      const docs = await settlementsCollection.find({
        type,
        settlementId,
        owner: {
          $exists: true
        }
      })

      const client = await runtime.postgres.connect()
      try {
        await client.query('BEGIN')
        try {
          for (let doc of docs) {
            await insertFromSettlement(runtime, client, doc)
          }
        } catch (e) {
          await client.query('ROLLBACK')
          runtime.captureException(e, { extra: { report: 'settlement-report', settlementId } })
          throw e
        }
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }
}
