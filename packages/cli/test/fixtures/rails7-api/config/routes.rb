Rails.application.routes.draw do
  devise_for :users
  get "up" => "rails/health#show", as: :rails_health_check

  namespace :api do
    namespace :v1 do
      resources :reports, only: [:index, :show] do
        member do
          get :preview
        end
        collection do
          get :search
        end
        resources :comments, only: [:index, :create]
      end
      resource :account, only: [:show, :update]
    end
  end

  post "/webhooks/stripe", to: "webhooks#stripe"
  mount Sidekiq::Web => "/sidekiq"
end
