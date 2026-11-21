require "rails"
require "action_controller/railtie"
require "securerandom"

module DemoRails
  class Application < Rails::Application
    config.load_defaults 8.1
    config.api_only = true
    config.eager_load = false
    config.secret_key_base = SecureRandom.hex(32) # API sin sesiones: nada que guardar
    config.hosts = [ "127.0.0.1", "localhost" ]
    config.logger = ActiveSupport::Logger.new($stdout)
  end
end
