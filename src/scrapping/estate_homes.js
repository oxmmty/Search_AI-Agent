const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const EstateSchema = new Schema(
  {
    image_url: String,
    address: String,
    price: Number,
    beds: Number,
    baths: Number,
    space: String,
    damage_tags: [String],
    saletype_tags: [String],
    description: String,
    link: String,
    recommendation: String
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }
);

const Estate = mongoose.model('estate_homes', EstateSchema);

module.exports = Estate;
