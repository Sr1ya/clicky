// three.js r186 dropped build/three.min.js (r161+ is ES modules only). Clicky's
// overlay page is one HTML string with inline classic scripts, so this bundles
// the module build plus the addons we use into an IIFE that sets globals.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

window.THREE = THREE;
window.THREE_ADDONS = {
  RoomEnvironment,
  RoundedBoxGeometry,
  mergeGeometries,
  mergeVertices,
  toCreasedNormals,
  EffectComposer,
  RenderPass,
  GTAOPass,
  SMAAPass,
  OutputPass,
  LineSegments2,
  LineSegmentsGeometry,
  LineMaterial,
};
