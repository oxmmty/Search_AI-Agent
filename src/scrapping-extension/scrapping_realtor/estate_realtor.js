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
    recommendation: String,
    sources: [String],
    city: String
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }
);

const Estate = mongoose.model('estate_realtor', EstateSchema);

module.exports = Estate;
