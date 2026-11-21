module Api
  module V1
    class CommentsController < ApplicationController
      before_action :authenticate_user!
    end
  end
end
