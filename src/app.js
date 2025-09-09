const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const mongoose = require('mongoose');
const { DB_PORT } = require('./configs/database');

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

// Connect to MongoDB
mongoose.set('strictQuery', false);
mongoose
  .connect(DB_PORT, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log('Connecting to database successful');
  })
  .catch((err) => console.error('Could not connect to mongo DB', err));

app.get('/health', (req, res) => {
  res.status(200).send('Cool!');
});
app.use('/app', appRouter);

module.exports = app;
