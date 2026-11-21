module Api
  module V1
    class AccountsController < ApplicationController
      before_action :authenticate_user!
    end
  end
end
