Rails.application.config.middleware.use Botgate::Middleware,
  api_key: ENV.fetch("BOTGATE_API_KEY"), site_id: ENV.fetch("BOTGATE_SITE_ID"), endpoint: ENV.fetch("BOTGATE_ENDPOINT"),
  licensed_paths: [ "/api/datos/**" ]
