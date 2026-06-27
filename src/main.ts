import Distraught from './distraught';

let viewer: Distraught;

viewer = new Distraught({
    container: '#app',
    objFile: '/นิ้วกลาง.obj',
    mtlFile: '/นิ้วกลาง.mtl',
    backgroundColor: ['#7EC8F5', '#FFF9F0'],
    onLoad: () => {
        viewer.setPedestalMode(true);
        viewer.setGridVisible(false);
    }
});