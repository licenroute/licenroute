module Api
  class CatalogoController < ApplicationController
    def index = render(json: [ { sku: "A1" } ])
  end
end
