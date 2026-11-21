module Api
  class Application < Rails::Application
    config.load_defaults 7.2
    config.api_only = true
  end
end
