Rails.application.routes.draw do
  get "/api/datos/:id", to: "datos#show"
  get "/api/nuevos", to: "nuevos#index"
end
