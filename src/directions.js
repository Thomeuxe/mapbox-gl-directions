if (!mapboxgl) throw new Error('include mapboxgl before mapbox-gl-directions.js');

import { createStore, applyMiddleware, bindActionCreators } from 'redux';
import thunk from 'redux-thunk';
import { decode } from 'polyline';
import utils from './utils';
import rootReducer from './reducers';

const storeWithMiddleware = applyMiddleware(thunk)(createStore);
const store = storeWithMiddleware(rootReducer);

// State object management via redux
import * as actions from './actions';
import directionsStyle from './directions_style';

// Controls
import Inputs from './controls/inputs';
import Instructions from './controls/instructions';

export default class Directions extends mapboxgl.Control {

  constructor(options) {
    super();
    this.actions = bindActionCreators(actions, store.dispatch);
    this.actions.setOptions(options || {});

    this.onMouseDown = this._onMouseDown.bind(this);
    this.move = this._move.bind(this);
    this.onClick = this._onClick.bind(this);
  }

  onAdd(map) {
    this.map = map;

    const { container, controls } = store.getState();

    this.container = container ? typeof container === 'string' ?
      document.getElementById(container) : container : this.map.getContainer();

    // Add controls to the page
    const inputEl = document.createElement('div');
    inputEl.className = 'directions-control directions-control-inputs';
    new Inputs(inputEl, store, this.actions, this.map);

    const directionsEl = document.createElement('div');
    directionsEl.className = 'directions-control-directions-container';

    new Instructions(directionsEl, store, {
      hoverMarker: this.actions.hoverMarker,
      setRouteIndex: this.actions.setRouteIndex
    }, this.map);

    if (controls.inputs) this.container.appendChild(inputEl);
    if (controls.instructions) this.container.appendChild(directionsEl);

    this.subscribedActions();
    map.on('style.load', () => this.mapState());
  }

  mapState() {
    const { profile, styles, interactive } = store.getState();

    // Emit any default or option set config
    this.actions.eventEmit('profile', { profile });

    const map = this.map;
    const geojson = new mapboxgl.GeoJSONSource({
      data: {
        type: 'FeatureCollection',
        features: []
      }
    });

    // Add and set data theme layer/style
    map.addSource('directions', geojson);

    // Add direction specific styles to the map
    directionsStyle.forEach((style) => map.addLayer(style));

    if (styles && styles.length) styles.forEach((style) => map.addLayer(style));

    if (interactive) {
      map.on('mousedown', this.onMouseDown);
      map.on('mousemove', this.move);
      map.on('click', this.onClick);
    }
  }

  subscribedActions() {
    store.subscribe(() => {
      const {
        origin,
        destination,
        hoverMarker,
        directions,
        routeIndex
      } = store.getState();

      const geojson = {
        type: 'FeatureCollection',
        features: [
          origin,
          destination,
          hoverMarker
        ].filter((d) => {
          return d.geometry;
        })
      };

      if (directions.length) {
        directions.forEach((feature, index) => {

          const lineString = {
            geometry: {
              type: 'LineString',
              coordinates: decode(feature.geometry, 6).map((c) => {
                return c.reverse();
              })
            },
            properties: {
              'route-index': index,
              route: (index === routeIndex) ? 'selected' : 'alternate'
            }
          };

          geojson.features.push(lineString);

          if (index === routeIndex) {
            // Collect any possible waypoints from steps
            feature.steps.forEach((d) => {
              if (d.maneuver.type === 'waypoint') {
                geojson.features.push({
                  type: 'Feature',
                  geometry: d.maneuver.location,
                  properties: {
                    id: 'waypoint'
                  }
                });
              }
            });
          }

        });
      }

      if (this.map.style) this.map.getSource('directions').setData(geojson);
    });
  }

  _onClick(e) {
    const { origin } = store.getState();
    const coords = [e.lngLat.lng, e.lngLat.lat];

    if (!origin.geometry) {
      this.actions.setOriginFromCoordinates(coords);
    } else {

      const features = this.map.queryRenderedFeatures(e.point, {
        layers: [
          'directions-origin-point',
          'directions-destination-point',
          'directions-waypoint-point',
          'directions-route-line-alt'
        ]
      });

      if (features.length) {

        // Remove any waypoints
        features.forEach((f) => {
          if (f.layer.id === 'directions-waypoint-point') {
            this.actions.removeWaypoint(f);
          }
        });

        if (features[0].properties.route === 'alternate') {
          const index = features[0].properties['route-index'];
          this.actions.setRouteIndex(index);
        }
      } else {
        this.actions.setDestinationFromCoordinates(coords);
        this.map.flyTo({ center: coords });
      }
    }
  }

  _move(e) {
    const { hoverMarker } = store.getState();

    const features = this.map.queryRenderedFeatures(e.point, {
      layers: [
        'directions-route-line-alt',
        'directions-route-line',
        'directions-origin-point',
        'directions-destination-point',
        'directions-hover-point'
      ]
    });

    this.map.getCanvas().style.cursor = features.length ? 'pointer' : '';

    if (features.length) {
      this.isCursorOverPoint = features[0];
      this.map.dragPan.disable();

      // Add a possible waypoint marker when hovering over the active route line
      features.forEach((feature) => {
        if (feature.layer.id === 'directions-route-line') {
          this.actions.hoverMarker([e.lngLat.lng, e.lngLat.lat]);
        } else if (hoverMarker.geometry) {
          this.actions.hoverMarker(null);
        }
      });

    } else if (this.isCursorOverPoint) {
      this.isCursorOverPoint = false;
      this.map.dragPan.enable();
    }
  }

  _onMouseDown() {
    if (!this.isCursorOverPoint) return;
    this.isDragging = this.isCursorOverPoint;
    this.map.getCanvas().style.cursor = 'grab';
    this.map.on('mousemove', (e) => this._onMouseMove(e));
    this.map.on('mouseup', (e) => this._onMouseUp(e));
  }

  _onMouseMove(e) {
    if (!this.isDragging) return;

    const coords = [e.lngLat.lng, e.lngLat.lat];
    switch (this.isDragging.layer.id) {
      case 'directions-origin-point':
        this.actions.createOrigin(coords);
      break;
      case 'directions-destination-point':
        this.actions.createDestination(coords);
      break;
      case 'directions-hover-point':
        this.actions.hoverMarker(coords);
      break;
    }
  }

  _onMouseUp() {
    if (!this.isDragging) return;

    const { hoverMarker, origin, destination } = store.getState();

    switch (this.isDragging.layer.id) {
      case 'directions-origin-point':
        this.actions.setOriginFromCoordinates(origin.geometry.coordinates);
      break;
      case 'directions-destination-point':
        this.actions.setDestinationFromCoordinates(destination.geometry.coordinates);
      break;
      case 'directions-hover-point':
        // Add waypoint if a sufficent amount of dragging has occurred.
        if (hoverMarker.geometry && !utils.coordinateMatch(this.isDragging, hoverMarker)) {
          this.actions.addWaypoint(0, hoverMarker);
        }
      break;
    }

    this.isDragging = false;
    this.map.getCanvas().style.cursor = '';
    this.map.off('mousemove', this._onMouseMove);
    this.map.off('mouseup', this._onMouseUp);
  }

  // API Methods
  // ============================

  /**
   * Turn on or off interactivity
   * @param {Boolean} state sets interactivity based on a state of `true` or `false`.
   * @returns {Directions} this
   */
  interactive(state) {
    if (state) {
      this.map.on('mousedown', this.onMouseDown);
      this.map.on('mousemove', this.move);
      this.map.on('click', this.onClick);
    } else {
      this.map.off('mousedown', this.onMouseDown);
      this.map.off('mousemove', this.move);
      this.map.off('click', this.onClick);
    }

    return this;
  }

  /**
   * Returns the origin of the current route.
   * @returns {Object} origin
   */
  getOrigin() {
    return store.getState().origin;
  }

  /**
   * Sets origin. _Note:_ calling this method requires the [map load event](https://www.mapbox.com/mapbox-gl-js/api/#Map.load)
   * to have run.
   * @param {Array<number>|String} query An array of coordinates [lng, lat] or location name as a string.
   * @returns {Directions} this
   */
  setOrigin(query) {
    if (typeof query === 'string') {
      this.actions.queryOrigin(query);
    } else {
      this.actions.setOriginFromCoordinates(query);
    }

    return this;
  }

  /**
   * Returns the destination of the current route.
   * @returns {Object} destination
   */
  getDestination() {
    return store.getState().destination;
  }

  /**
   * Sets destination. _Note:_ calling this method requires the [map load event](https://www.mapbox.com/mapbox-gl-js/api/#Map.load)
   * to have run.
   * @param {Array<number>|String} query An array of coordinates [lng, lat] or location name as a string.
   * @returns {Directions} this
   */
  setDestination(query) {
    if (typeof query === 'string') {
      this.actions.queryDestination(query);
    } else {
      this.actions.setDestinationFromCoordinates(query);
    }

    return this;
  }

  /**
   * Swap the origin and destination.
   * @returns {Directions} this
   */
  reverse() {
    this.actions.reverse();
    return this;
  }

  /**
   * Add a waypoint to the route. _Note:_ calling this method requires the
   * [map load event](https://www.mapbox.com/mapbox-gl-js/api/#Map.load) to have run.
   * @param {Number} index position waypoint should be placed in the waypoint array
   * @param {Array<number>|Point} waypoint can be a GeoJSON Point Feature or [lng, lat] coordinates.
   * @returns {Directions} this;
   */
  addWaypoint(index, waypoint) {
    if (!waypoint.type) waypoint = utils.createPoint(waypoint, { id: 'waypoint' });
    this.actions.addWaypoint(index, waypoint);
    return this;
  }

  /**
   * Change the waypoint at a given index in the route. _Note:_ calling this
   * method requires the [map load event](https://www.mapbox.com/mapbox-gl-js/api/#Map.load)
   * to have run.
   * @param {Number} index indexed position of the waypoint to update
   * @param {Array<number>|Point} waypoint can be a GeoJSON Point Feature or [lng, lat] coordinates.
   * @returns {Directions} this;
   */
  setWaypoint(index, waypoint) {
    if (!waypoint.type) waypoint = utils.createPoint(waypoint, { id: 'waypoint' });
    this.actions.setWaypoint(index, waypoint);
    return this;
  }

  /**
   * Remove a waypoint from the route.
   * @param {Number} index position in the waypoints array.
   * @returns {Directions} this;
   */
  removeWaypoint(index) {
    const { waypoints } = store.getState();
    this.actions.removeWaypoint(waypoints[index]);
    return this;
  }

  /**
   * Fetch all current waypoints in a route.
   * @returns {Array} waypoints
   */
  getWaypoints() {
    return store.getState().waypoints;
  }

  /**
   * Subscribe to events that happen within the plugin.
   * @param {String} type name of event. Available events and the data passed into their respective event objects are:
   *
   * - __clear__ `{ type: } Type is one of 'origin' or 'destination'`
   * - __loading__ `{ type: } Type is one of 'origin' or 'destination'`
   * - __profile__ `{ profile } Profile is one of 'driving', 'walking', or 'cycling'`
   * - __origin__ `{ feature } Fired when origin is set`
   * - __destination__ `{ feature } Fired when destination is set`
   * - __route__ `{ route } Fired when a route is updated`
   * - __error__ `{ error } Error as string
   * @param {Function} fn function that's called when the event is emitted.
   * @returns {Directions} this;
   */
  on(type, fn) {
    this.actions.eventSubscribe(type, fn);
    return this;
  }
}
