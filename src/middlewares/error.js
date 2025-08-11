const catchError = (callback) => {
  return async (req, res, next) => {
    try {
      await callback(req, res, next);
    } catch (e) {
      console.error(e);

      return res.status(500).send({
        status: false,
        message: 'internal_server_error',
      });
    }
  };
};

module.exports = {
  catchError,
};
