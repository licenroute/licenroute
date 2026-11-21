Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check
  root "pages#home"
  namespace :api do
    resources :informes, only: [:index, :show]
    get "catalogo", to: "catalogo#index"
    post "pedidos", to: "pedidos#create"
  end
end
