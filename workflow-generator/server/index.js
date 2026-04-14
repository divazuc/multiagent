'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const express = require('express')
const cors = require('cors')
const path = require('path')

const generateRouter = require('./routes/generate')
const editRouter = require('./routes/edit')
const n8nRouter = require('./routes/n8n')
const projectRouter = require('./routes/project')

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.use('/api/generate', generateRouter)
app.use('/api/edit', editRouter)
app.use('/api/n8n', n8nRouter)
app.use('/api/projects', projectRouter)

// Serve React build in production
const clientBuild = path.join(__dirname, '../client/dist')
app.use(express.static(clientBuild))
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuild, 'index.html'))
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))

module.exports = app
