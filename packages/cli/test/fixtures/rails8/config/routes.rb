Rails.application.routes.draw do
  resource :session
  resources :passwords, param: :token
  get "up" => "rails/health#show", as: :rails_health_check
  root "pages#home"

  resources :articles do
    resources :revisions, only: [:index, :show]
  end
  get "informes/:year", to: "reports#show"

  draw(:admin)

  if Rails.env.development?
    get "/debug/tools", to: "debug#index"
  end

  %w[terminos privacidad].each do |page|
    get "/legal/#{page}", to: "legal#show"
  end

  concern :commentable do
    resources :comments
  end
end
