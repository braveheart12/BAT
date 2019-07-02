const moment = require('moment')
const {
  updateBalances
} = require('../lib/transaction')

const freezeInterval = process.env.FREEZE_SURVEYORS_AGE_DAYS

const feePercent = 0.05

const daily = async (debug, runtime) => {
  const { database } = runtime

  debug('daily', 'running')

  try {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    await database.purgeSince(debug, runtime, midnight)

    await freezeOldSurveyors(debug, runtime)
  } catch (ex) {
    runtime.captureException(ex)
    debug('daily', { reason: ex.toString(), stack: ex.stack })
  }

  const tomorrow = new Date()
  tomorrow.setHours(24, 0, 0, 0)
  setTimeout(() => { daily(debug, runtime) }, tomorrow - new Date())
  debug('daily', 'running again ' + moment(tomorrow).fromNow())
}

async function hourly (debug, runtime) {
  const client = await runtime.postgres.connect()
  await updateBalances(runtime, client, true)

  const nextTime = timeUntil(1000 * 60 * 60)
  setTimeout(() => hourly(debug, runtime), nextTime)
  const nextDate = (new Date((nextTime + +(new Date())))).toISOString()
  debug('hourly', `running again ${nextDate}`)
}

function timeUntil (interval) {
  const now = new Date()
  const thisTime = now - (now % interval)
  const nextTime = thisTime + interval
  const timeUntil = nextTime - new Date()
  return timeUntil
}

exports.name = 'reports'
exports.freezeOldSurveyors = freezeOldSurveyors

/*
  olderThanDays: int
*/
async function freezeOldSurveyors (debug, runtime, olderThanDays) {
  if (typeof olderThanDays === 'undefined') {
    olderThanDays = freezeInterval
  }

  const query = `
  update surveyor_groups set frozen = true
  where not frozen and created_at < current_date - $1 * interval '1d'
  returning id;
  `

  const {
    rows
  } = await runtime.postgres.query(query, [olderThanDays])

  await Promise.all(rows.map(async (row) => {
    const surveyorId = row.id
    await runtime.queue.send(debug, 'surveyor-frozen-report', { surveyorId, mix: true })
  }))
}

const mixer = async (debug, runtime, filter, qid) => {
  const query = `
  update votes
  set
    amount = (1 - $1::decimal) * votes.tally * surveyor_groups.price,
    fees =  $1::decimal * votes.tally * surveyor_groups.price
  from surveyor_groups
  where votes.surveyor_id = surveyor_groups.id and not votes.excluded and surveyor_groups.frozen;
  `
  return runtime.postgres.query(query, [feePercent])
}

exports.mixer = mixer

exports.initialize = async (debug, runtime) => {
  if (typeof freezeInterval === 'undefined' || isNaN(parseFloat(freezeInterval))) {
    throw new Error('FREEZE_SURVEYORS_AGE_DAYS is not set or not numeric')
  }

  if ((typeof process.env.DYNO === 'undefined') || (process.env.DYNO === 'worker.1')) {
    setTimeout(() => { daily(debug, runtime) }, 5 * 1000)
    setTimeout(() => hourly(debug, runtime), timeUntil(1000 * 60 * 60))
  }
}
