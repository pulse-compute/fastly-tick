import { Router } from '@pulse-compute/runtime'
import { tickHandler, tickError } from './handler.js'

const tick = new Router()
tick.post('/__tick', tickHandler)
tick.error(tickError)
export default tick
