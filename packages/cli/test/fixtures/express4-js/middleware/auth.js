exports.requireAuth = (req, res, next) => (req.headers.authorization ? next() : res.sendStatus(401));
