export const requireUser = (req, res, next) => (req.headers.authorization ? next() : res.sendStatus(401));
