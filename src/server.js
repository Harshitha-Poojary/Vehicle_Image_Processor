const express = require('express');
const imagesRouter = require('./routes/images');
const { startWorker } = require('./worker/index');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/images', imagesRouter);

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
