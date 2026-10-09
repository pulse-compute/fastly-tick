import { Pulse } from '@pulse-compute/pulse'
import { tickHandler, tickError } from './tick/handler.js'

const app = new Pulse({ auto: true })
// New workers default to /__tick. Keep the receiver's fixed legacy descriptor too.
app.post('/__tick', tickHandler)
app.post('/__tick/run', tickHandler)
app.error(tickError)
export default app
