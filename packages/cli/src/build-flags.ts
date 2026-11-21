/**
 * El paquete compilado define `__LICENROUTE_DIST_BUILD__` como true en el empaquetado. En este repositorio el
 * identificador no existe: `typeof` vale "undefined" y no se puede activar con una variable de entorno.
 */
declare const __LICENROUTE_DIST_BUILD__: boolean;

export const DIST_BUILD = typeof __LICENROUTE_DIST_BUILD__ !== "undefined" && __LICENROUTE_DIST_BUILD__;
