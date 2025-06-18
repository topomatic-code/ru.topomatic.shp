import SHPImporter from './SHPImporter';

export default {
    'shp:importer': async (ctx: Context) => {
        return new SHPImporter(ctx);
    },
    'shp:add:file': async (ctx: Context) => {
        console.log(ctx);
    }
}
