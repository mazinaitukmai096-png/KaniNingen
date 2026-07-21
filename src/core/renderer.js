export function createRendererController({
  THREE,
  antialias,
  container = document.body,
  viewport = window,
} = {}) {
  let scene = null;
  let camera = null;
  let renderer = null;
  let disposed = false;

  function ensureRenderer() {
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({
        antialias,
        powerPreference: 'high-performance',
        logarithmicDepthBuffer: true,
      });
      renderer.setPixelRatio(Math.min(viewport.devicePixelRatio, 1.5));
      renderer.setSize(viewport.innerWidth, viewport.innerHeight);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      container.appendChild(renderer.domElement);
    }
    return renderer;
  }

  function createScene({ isMenu }) {
    scene = new THREE.Scene();

    if (isMenu) {
      scene.background = new THREE.Color(0x3a2c22);
      scene.fog = new THREE.Fog(0x3a2c22, 2000, 9000);
    } else {
      const skyColor = 0x5dade2;
      scene.background = new THREE.Color(skyColor);
      scene.fog = new THREE.Fog(skyColor, 3000, 14000);
    }

    camera = new THREE.PerspectiveCamera(
      70,
      viewport.innerWidth / viewport.innerHeight,
      10,
      35000,
    );

    ensureRenderer();

    scene.add(new THREE.HemisphereLight(0xffcfa0, 0x4a5c2e, 1.3));
    const sun = new THREE.DirectionalLight(0xffeb3b, 1.2);
    sun.position.set(1500, 2500, 1000);
    sun.castShadow = true;
    sun.shadow.camera.left = -5000;
    sun.shadow.camera.right = 5000;
    sun.shadow.camera.top = 5000;
    sun.shadow.camera.bottom = -5000;
    sun.shadow.mapSize.width = 1024;
    sun.shadow.mapSize.height = 1024;
    scene.add(sun);

    return Object.freeze({ scene, camera, renderer });
  }

  function resize() {
    if (!camera || !renderer) return;
    camera.aspect = viewport.innerWidth / viewport.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.innerWidth, viewport.innerHeight);
  }

  function render() {
    renderer.render(scene, camera);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    viewport.removeEventListener('resize', resize);
    if (renderer) {
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    }
    scene = null;
    camera = null;
    renderer = null;
  }

  viewport.addEventListener('resize', resize);

  return Object.freeze({ createScene, render, resize, dispose });
}
