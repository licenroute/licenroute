class ArticlesController < ApplicationController
  allow_unauthenticated_access only: %i[index show]
end
