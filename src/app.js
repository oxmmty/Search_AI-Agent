const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const appRouter = require('./routes');

const app = express();

const corsConfig = {
  credentials: true,
  origin: true,
};

app.use(cors(corsConfig));

app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../uploads')));

app.get('/health', (req, res) => {
  res.status(200).send('Cool!');
});
app.use('/app', appRouter);

module.exports = app;
