const express = require('express');
const path = require('path');
const imagesRouter = require('./routes/images');
const { startWorker } = require('./worker/index');

const app = express();
const PORT = process.env.PORT || 3000;
const frontendDir = path.resolve(__dirname, '..', 'front_end');

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/images', imagesRouter);
app.use(express.static(frontendDir));
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Multer/other errors that escape the route handler (e.g. file too large) land here.
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

startWorker();

app.listen(PORT, () => {
  console.log(`Vehicle image processor listening on http://localhost:${PORT}`);
});
