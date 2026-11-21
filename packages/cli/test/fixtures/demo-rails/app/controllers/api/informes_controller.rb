module Api
  class InformesController < ApplicationController
    def index = render(json: [ { id: 1 } ])
    def show = render(json: { informe: params[:id] })
  end
end
