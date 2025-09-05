const mongoose = require('mongoose');
const {
  DB_PORT,
} = require('./config');

/**
 * Connect Monogo Database.
 */
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
