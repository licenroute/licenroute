module.exports = function registerAdmin(app) {
  app.get("/admin/users", (req, res) => res.json([]));
};
