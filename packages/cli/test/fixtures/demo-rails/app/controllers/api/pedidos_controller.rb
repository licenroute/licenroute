module Api
  class PedidosController < ApplicationController
    def create = render(json: { pedido: "nuevo" }, status: :created)
  end
end
