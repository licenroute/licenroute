class PagesController < ApplicationController
  def home = render(json: { tienda: "demo" })
end
