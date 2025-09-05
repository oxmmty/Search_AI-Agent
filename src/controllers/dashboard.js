const Estate = require("../models/estate");

const getData = async (req, res) => {
  const { cities, damage_tags, saletype_tags, page } = req.body;

  let query = {};

  if (cities.length > 0) {
    query.address = {
      $regex: cities.map(city => `(${city})`).join('|'),
      $options: 'i'
    };
  }

  if (damage_tags.length > 0) {
    query.damage_tags = { $in: damage_tags };
  }

  if (saletype_tags.length > 0) {
    query.saletype_tags = { $in: saletype_tags };
  }

  if (damage_tags.length === 0 && saletype_tags.length === 0) {
    if (cities.length > 0) {
      query = {
        $and: [
          {
            $or: [
              { damage_tags: { $ne: [] } },
              { saletype_tags: { $ne: [] } }
            ]
          },
          {
            address: { $regex: cities.map(city => `(${city})`).join('|'), $options: 'i' }
          }
        ]
      };
    } else {
      query = {
        $or: [
          { damage_tags: { $ne: [] } },
          { saletype_tags: { $ne: [] } }
        ]
      };
    }
  }

  const estates = await Estate.find(query).skip((page-1)*24).limit(24).catch(e => console.log(e));
  const total = await Estate.countDocuments(query).catch(e => console.log(e));

  return res.send({
    status: true,
    result: { data: estates, total: total }
  })
}

module.exports = {
  getData
}
