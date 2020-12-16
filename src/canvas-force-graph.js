import {
  forceSimulation as d3ForceSimulation,
  forceLink as d3ForceLink,
  forceManyBody as d3ForceManyBody,
  forceCenter as d3ForceCenter,
  forceRadial as d3ForceRadial
} from 'd3-force-3d';

import { Bezier } from 'bezier-js';

import Kapsule from 'kapsule';
import accessorFn from 'accessor-fn';
import indexBy from 'index-array-by';

import getDagDepths from './dagDepths';

//

const DAG_LEVEL_NODE_RATIO = 2;

export default Kapsule({

  props: {
    graphData: {
      default: {
        nodes: [],
        links: []
      },
      onChange(_, state) {
        state.engineRunning = false;
      } // Pause simulation
    },
    dagMode: { onChange(dagMode, state) { // td, bu, lr, rl, radialin, radialout
      !dagMode && (state.graphData.nodes || []).forEach(n => n.fx = n.fy = undefined); // unfix nodes when disabling dag mode
    }},
    dagLevelDistance: {},
    dagNodeFilter: { default: node => true },
    onDagError: { triggerUpdate: false },
    nodeRelSize: { default: 4, triggerUpdate: false }, // area per val unit
    nodeId: { default: 'id' },
    nodeVal: { default: 'val', triggerUpdate: false },
    nodeColor: { default: 'color', triggerUpdate: false },
    nodeAutoColorBy: {},
    nodeCanvasObject: { triggerUpdate: false },
    nodeCanvasObjectMode: { default: () => 'replace', triggerUpdate: false },
    nodeVisibility: { default: true, triggerUpdate: false },
    linkSource: { default: 'source' },
    linkTarget: { default: 'target' },
    linkVisibility: { default: true, triggerUpdate: false },
    linkColor: { default: 'color', triggerUpdate: false },
    linkAutoColorBy: {},
    linkLineDash: { triggerUpdate: false },
    linkWidth: { default: 1, triggerUpdate: false },
    linkCurvature: { default: 0, triggerUpdate: false },
    linkCanvasObject: { triggerUpdate: false },
    linkCanvasObjectMode: { default: () => 'replace', triggerUpdate: false },
    linkDirectionalArrowLength: { default: 0, triggerUpdate: false },
    linkDirectionalArrowColor: { triggerUpdate: false },
    linkDirectionalArrowRelPos: { default: 0.5, triggerUpdate: false }, // value between 0<>1 indicating the relative pos along the (exposed) line
    linkDirectionalParticles: { default: 0 }, // animate photons travelling in the link direction
    linkDirectionalParticleSpeed: { default: 0.01, triggerUpdate: false }, // in link length ratio per frame
    linkDirectionalParticleWidth: { default: 4, triggerUpdate: false },
    linkDirectionalParticleColor: { triggerUpdate: false },
    globalScale: { default: 1, triggerUpdate: false },
    d3AlphaMin: { default: 0, triggerUpdate: false},
    d3AlphaDecay: { default: 0.0228, triggerUpdate: false, onChange(alphaDecay, state) { state.forceLayout.alphaDecay(alphaDecay) }},
    d3AlphaTarget: { default: 0, triggerUpdate: false, onChange(alphaTarget, state) { state.forceLayout.alphaTarget(alphaTarget) }},
    d3VelocityDecay: { default: 0.4, triggerUpdate: false, onChange(velocityDecay, state) { state.forceLayout.velocityDecay(velocityDecay) } },
    warmupTicks: { default: 0, triggerUpdate: false }, // how many times to tick the force engine at init before starting to render
    cooldownTicks: { default: Infinity, triggerUpdate: false },
    cooldownTime: { default: 15000, triggerUpdate: false }, // ms
    onUpdate: { default: () => {}, triggerUpdate: false },
    onFinishUpdate: { default: () => {}, triggerUpdate: false },
    onEngineTick: { default: () => {}, triggerUpdate: false },
    onEngineStop: { default: () => {}, triggerUpdate: false },
    isShadow: { default: false, triggerUpdate: false }
  },

  methods: {
    // Expose d3 forces for external manipulation
    d3Force: function(state, forceName, forceFn) {
      if (forceFn === undefined) {
        return state.forceLayout.force(forceName); // Force getter
      }
      state.forceLayout.force(forceName, forceFn); // Force setter
      return this;
    },
    d3ReheatSimulation: function(state) {
      state.forceLayout.alpha(1);
      this.resetCountdown();
      return this;
    },
    // reset cooldown state
    resetCountdown: function(state) {
      state.cntTicks = 0;
      state.startTickTime = new Date();
      state.engineRunning = true;
      return this;
    },
    tickFrame: function(state) {
      layoutTick();
      paintNodes();
      paintLinks();

      return this;

      //

      function layoutTick() {
        if (state.engineRunning) {
          if (
            ++state.cntTicks > state.cooldownTicks ||
            (new Date()) - state.startTickTime > state.cooldownTime ||
            (state.d3AlphaMin > 0 && state.forceLayout.alpha() < state.d3AlphaMin)
          ) {
            state.engineRunning = false; // Stop ticking graph
            state.onEngineStop();
          } else {
            state.forceLayout.tick(); // Tick it
            state.onEngineTick();
          }
        }
      }

      function paintNodes() {
        if ( !state.nodeCanvasObject ) return;
        var getVisibility = accessorFn(state.nodeVisibility);
        var ctx = state.ctx;
        var visibleNodes = state.graphData.nodes.filter(getVisibility);
        ctx.save();
        visibleNodes.forEach(node => {
          state.nodeCanvasObject(node, ctx, state.globalScale, state.isShadow);
          ctx.restore();
        });
        ctx.restore();
      }

      function paintLinks() {
        const getVisibility = accessorFn(state.linkVisibility);
        const getColor = accessorFn(state.linkColor);
        const getWidth = accessorFn(state.linkWidth);
        const getLineDash = accessorFn(state.linkLineDash);
        const getCurvature = accessorFn(state.linkCurvature);
        const getLinkCanvasObjectMode = accessorFn(state.linkCanvasObjectMode);

        const ctx = state.ctx;

        // Draw wider lines by 2px on shadow canvas for more precise hovering (due to boundary anti-aliasing)
        const padAmount = state.isShadow * 2;

        const visibleLinks = state.graphData.links.filter(getVisibility);
        visibleLinks.forEach(calcLinkControlPoints); // calculate curvature control points for all visible links

        let beforeCustomLinks = [], afterCustomLinks = [], defaultPaintLinks = visibleLinks;
        if (state.linkCanvasObject) {
          const replaceCustomLinks = [], otherCustomLinks = [];

          visibleLinks.forEach(d =>
            ({
              before: beforeCustomLinks,
              after: afterCustomLinks,
              replace: replaceCustomLinks
            }[getLinkCanvasObjectMode(d)] || otherCustomLinks).push(d)
          );
          defaultPaintLinks = [...beforeCustomLinks, ...afterCustomLinks, ...otherCustomLinks];
          beforeCustomLinks = beforeCustomLinks.concat(replaceCustomLinks);
        }

        // Bundle strokes per unique color/width/dash for performance optimization
        const linksPerColor = indexBy(defaultPaintLinks, [getColor, getWidth, getLineDash]);

        ctx.save();
        Object.entries(linksPerColor).forEach(([color, linksPerWidth]) => {
          const lineColor = !color || color === 'undefined' ? 'rgba(0,0,0,0.15)' : color;
          Object.entries(linksPerWidth).forEach(([width, linesPerLineDash]) => {
            const lineWidth = (width || 1) / state.globalScale + padAmount;
            Object.entries(linesPerLineDash).forEach(([dashSegments, links]) => {
              const lineDashSegments = getLineDash(links[0]);
              ctx.beginPath();
              links.forEach(link => {
                const start = link.source;
                const end = link.target;
                if (!start || !end || !start.hasOwnProperty('x') || !end.hasOwnProperty('x')) return; // skip invalid link

                ctx.moveTo(start.x, start.y);

                const controlPoints = link.__controlPoints;

                if (!controlPoints) { // Straight line
                  ctx.lineTo(end.x, end.y);
                } else {
                  // Use quadratic curves for regular lines and bezier for loops
                  ctx[controlPoints.length === 2 ? 'quadraticCurveTo' : 'bezierCurveTo'](...controlPoints, end.x, end.y);
                }
              });
              ctx.strokeStyle = lineColor;
              ctx.lineWidth = lineWidth;
              ctx.setLineDash(lineDashSegments || []);
              ctx.stroke();
            });
          });
        });
        ctx.restore();

        //

        function calcLinkControlPoints(link) {
          const curvature = getCurvature(link);

          if (!curvature) { // straight line
            link.__controlPoints = null;
            return;
          }

          const start = link.source;
          const end = link.target;
          if (!start || !end || !start.hasOwnProperty('x') || !end.hasOwnProperty('x')) return; // skip invalid link

          const l = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)); // line length

          if (l > 0) {
            const a = Math.atan2(end.y - start.y, end.x - start.x); // line angle
            const d = l * curvature; // control point distance

            const cp = { // control point
              x: (start.x + end.x) / 2 + d * Math.cos(a - Math.PI / 2),
              y: (start.y + end.y) / 2 + d * Math.sin(a - Math.PI / 2)
            };

            link.__controlPoints = [cp.x, cp.y];
          } else { // Same point, draw a loop
            const d = curvature * 70;
            link.__controlPoints = [end.x, end.y - d, end.x + d, end.y];
          }
        }
      }

    },
    emitParticle: function(state, link) {
      if (link) {
        !link.__photons && (link.__photons = []);
        link.__photons.push({__singleHop: true}); // add a single hop particle
      }

      return this;
    }
  },

  stateInit: () => ({
    forceLayout: d3ForceSimulation()
      .force('link', d3ForceLink())
      .force('charge', d3ForceManyBody())
      .force('center', d3ForceCenter())
      .force('dagRadial', null)
      .stop(),
    engineRunning: false
  }),

  init(canvasCtx, state) {
    // Main canvas object to manipulate
    state.ctx = canvasCtx;
  },

  update(state) {
    state.engineRunning = false; // Pause simulation
    state.onUpdate();

    // parse links
    state.graphData.links.forEach(link => {
      link.source = link[state.linkSource];
      link.target = link[state.linkTarget];
    });

    if (!state.isShadow) {
      // Add photon particles
      const linkParticlesAccessor = accessorFn(state.linkDirectionalParticles);
      state.graphData.links.forEach(link => {
        const numPhotons = Math.round(Math.abs(linkParticlesAccessor(link)));
        if (numPhotons) {
          link.__photons = [...Array(numPhotons)].map(() => ({}));
        } else {
          delete link.__photons;
        }
      });
    }

    // Feed data to force-directed layout
    state.forceLayout
      .stop()
      .alpha(1) // re-heat the simulation
      .nodes(state.graphData.nodes);

    // add links (if link force is still active)
    const linkForce = state.forceLayout.force('link');
    if (linkForce) {
      linkForce
        .id(d => d[state.nodeId])
        .links(state.graphData.links);
    }

    // setup dag force constraints
    const nodeDepths = state.dagMode && getDagDepths(
      state.graphData,
      node => node[state.nodeId],
      {
        nodeFilter: state.dagNodeFilter,
        onLoopError: state.onDagError || undefined
      }
    );
    const maxDepth = Math.max(...Object.values(nodeDepths || []));
    const dagLevelDistance = state.dagLevelDistance || (
        state.graphData.nodes.length / (maxDepth || 1) * DAG_LEVEL_NODE_RATIO
        * (['radialin', 'radialout'].indexOf(state.dagMode) !== -1 ? 0.7 : 1)
      );

    // Fix nodes to x,y for dag mode
    if (state.dagMode) {
      const getFFn = (fix, invert) => node => !fix
        ? undefined
        : (nodeDepths[node[state.nodeId]] - maxDepth / 2) * dagLevelDistance * (invert ? -1 : 1);

      const fxFn = getFFn(['lr', 'rl'].indexOf(state.dagMode) !== -1, state.dagMode === 'rl');
      const fyFn = getFFn(['td', 'bu'].indexOf(state.dagMode) !== -1, state.dagMode === 'bu');

      state.graphData.nodes.filter(state.dagNodeFilter).forEach(node => {
        node.fx = fxFn(node);
        node.fy = fyFn(node);
      });
    }

    // Use radial force for radial dags
    state.forceLayout.force('dagRadial',
      ['radialin', 'radialout'].indexOf(state.dagMode) !== -1
        ? d3ForceRadial(node => {
        const nodeDepth = nodeDepths[node[state.nodeId]] || -1;
        return (state.dagMode === 'radialin' ? maxDepth - nodeDepth : nodeDepth) * dagLevelDistance;
      })
        .strength(node => state.dagNodeFilter(node) ? 1 : 0)
        : null
    );

    for (let i=0; (i<state.warmupTicks) && !(state.d3AlphaMin > 0 && state.forceLayout.alpha() < state.d3AlphaMin); i++) {
      state.forceLayout.tick();
    } // Initial ticks before starting to render

    this.resetCountdown();
    state.onFinishUpdate();
  }
});
