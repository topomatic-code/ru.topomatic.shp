import shp from 'shpjs';
import { MimeType, QuickPickItemKind } from 'albatros/enums';

interface ShapeGroup {
    shp: ArrayBufferLike;
    dbf?: ArrayBufferLike;
    shx?: ArrayBufferLike;
    sbn?: ArrayBufferLike;
    sbx?: ArrayBufferLike;
    aih?: ArrayBufferLike;
    ain?: ArrayBufferLike;
    prj?: ArrayBufferLike;
    cpg?: ArrayBufferLike;
    idx?: ArrayBufferLike;
}

interface Point  {
    type: 'Point';
    coordinates: vec2 | vec3;
}
interface LineString  {
    type: 'LineString';
    coordinates: vec2[] | vec3[];
    bbox: box2;
}
interface Polygon  {
    type: 'Polygon';
    coordinates: vec2[][] | vec3[][];
    bbox: box2;
}
interface MultiPoint {
    type: 'MultiPoint';
    coordinates: vec2[] | vec3[];
}
interface MultiLineString {
    type: 'MultiLineString';
    coordinates: vec2[][] | vec3[][];
}
interface MultiPolygon {
    type: 'MultiPolygon';
    coordinates: vec2[][][] | vec3[][][];
}
type Geometry = Point | LineString | Polygon | MultiPoint | MultiLineString | MultiPolygon;

type PropertyType = 'number' | 'string' | 'boolean' | 'Date';
type PropertyValue = number | string | boolean | Date;

interface Feature {
    type: 'Feature';
    geometry: Geometry;
    properties: Record<string, PropertyValue>;
}

interface FeatureCollection {
    type: 'FeatureCollection';
    features: Feature[];
}

type GeoJSON = FeatureCollection; // TODO: add other types

const ALLOWED_EXTENSIONS = new Set(['shp', 'dbf', 'shx', 'sbn', 'sbx', 'aih', 'ain', 'prj', 'cpg', 'idx']);

async function addToGroups(groups: Record<string, ShapeGroup>, item: WorkspaceItem, outputs: OutputChannel, progress: WorkerProgress): Promise<void> {
    const bytes = await item.get();
    const title = item.title;
    progress.details = title;
    const name = title.substring(0, title.length - 4);
    const extension = title.substring(title.length - 3) as keyof ShapeGroup;
    if (!ALLOWED_EXTENSIONS.has(extension)) {
        outputs.error('Unsupported extension {0}', extension);
        return;
    }
    let group = groups[name];
    if (group === undefined) {
        group = {} as ShapeGroup;
        groups[name] = group;
    }
    group[extension] = bytes.buffer;
}

async function extractGroups(groups: Record<string, ShapeGroup>, items: WorkspaceItem[], outputs: OutputChannel, progress: WorkerProgress): Promise<void> {
    for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        switch (item.mimeType) {
            case MimeType.folder:
                await extractGroups(groups, await item.propfind(), outputs, progress);
                break;
            default:
                await addToGroups(groups, item, outputs, progress);
                break;
        }
    }
}

function addPropName(propNames: Record<string, Record<PropertyType, PropertyValue>>, propName: string, propValue: PropertyValue): void {
    let type: PropertyType | undefined;
    switch (typeof propValue) {
        case 'number':
            if (!isFinite(propValue)) {
                return;
            }
            type = 'number';
            break;
        case 'string':
            if (propValue.length === 0) {
                return;
            }
            type = 'string';
            propValue = `\"${propValue}\"`;
            break;
        default:
            if (propValue instanceof Date) {
                if (isNaN(propValue.valueOf())) {
                    return;
                }
                type = 'Date';
                propValue = propValue.toLocaleString();
            }
            break;
    }
    if (type === undefined) {
        return;
    }
    let examples = propNames[propName];
    if (examples !== undefined) {
        propNames[propName][type] = propValue;
    } else {
        propNames[propName] = { [type]: propValue } as Record<PropertyType, PropertyValue>;
    }
}

async function decodeGeoJSONs(geoJSONs: Record<string, GeoJSON>, propNames: Record<string, Record<PropertyType, PropertyValue>>, groups: Record<string, ShapeGroup>): Promise<void> {
    for (const name in groups) {
        const group = groups[name];
        // @ts-expect-error | allowed argument type
        const geojson = await shp(group) as GeoJSON;
        geoJSONs[name] = geojson;
        switch (geojson.type) {
            case 'FeatureCollection': {
                const features = geojson.features;
                for (let i = 0; i < features.length; ++i) {
                    const feature = features[i];
                    switch (feature.type) {
                        case 'Feature': {
                            const props = feature.properties;
                            for (const propName in props) {
                                addPropName(propNames, propName, props[propName]);
                            }
                            break;
                        }
                        default:
                            break;
                    }
                }
                break;
            }
            default:
                break;
        }
    }
}

async function choosePossibleLayerNameProps(context: Context, propNames: Record<string, Record<PropertyType, PropertyValue>>): Promise<string[]> {
    const options = new Array<QuickPickItem>();
    for (const propName in propNames) {
        const examples = propNames[propName];
        let typesString = '';
        for (const propType in examples) {
            typesString += `${propType}: ${examples[propType as PropertyType]}, `;
        }
        options.push({
            label: propName,
            kind: QuickPickItemKind.Default,
            detail: `${context.tr('Примеры')}: ${typesString.substring(0, typesString.length - 2)}`,
        });
    }
    const selected = await context.showQuickPick(options, {
        title: context.tr('Выберите поля, которые могут использоваться в качестве имени слоя'),
        canPickMany: true,
    });
    const selectedNames = new Array<string>(selected.length);
    for (let i = 0; i < selected.length; ++i) {
        selectedNames[i] = selected[i].label;
    }
    return selectedNames;
}

function featurePropValue(prop: PropertyValue, outputs: OutputChannel): DwgTypedObject {
    switch (typeof prop) {
        case 'number':
            return {
                $value: prop,
                $type: Number.isInteger(prop) ? 'int' : 'float',
                $units: undefined,
            };
        case 'string':
            return {
                $value: prop,
                $type: 'string',
            };
        case 'boolean':
            return {
                $value: prop,
                $type: 'bool',
            };
        default:
            if (prop instanceof Date) {
                return {
                    $value: prop.toLocaleString(),
                    $type: 'string',
                };
            } else {
                outputs.error('Unsupported property type {0}', prop);
                return {
                    $value: prop
                }
            }
    }
}

function featureProps(rawProps: Record<string, PropertyValue>, outputs: OutputChannel): DwgTypedObject {
    const props = {} as DwgTypedObject;
    for (const name in rawProps) {
        props[name] = featurePropValue(rawProps[name], outputs);
    }
    return props;
}

function coordinatesToVec3(coordinates: vec2 | vec3): vec3 {
    return coordinates.length >= 3 ? [coordinates[0], coordinates[1], coordinates[2]] as vec3 : [coordinates[0], coordinates[1], 0] as vec3;
}

const SCALE = 1; // TODO: use geodesic coordinates transform instead of scale

function scaleCoordinates(coordinates: vec3): vec3 {
    for (let i = 0; i < coordinates.length; ++i) {
        coordinates[i] *= SCALE;
    }
    return coordinates;
}

async function featureGeometry(editor: DwgEntityEditor, layer: DwgLayer, rawGeometry: Geometry, outputs: OutputChannel): Promise<void> {
    switch (rawGeometry.type) {
        case 'Point': {
            // TODO: add point primitive
            const entity = await editor.addCircle({
                center: scaleCoordinates(coordinatesToVec3(rawGeometry.coordinates)),
                radius: 0.005,
            });
            await entity.setx('$layer', layer);
            break;
        }
        case 'LineString': {
            let entity: DwgEntity | undefined;
            if (rawGeometry.coordinates.length === 2) {
                entity = await editor.addLine({
                    a: scaleCoordinates(coordinatesToVec3(rawGeometry.coordinates[0])),
                    b: scaleCoordinates(coordinatesToVec3(rawGeometry.coordinates[1])),
                });
            } else {
                const coordinates = rawGeometry.coordinates;
                for (let i = 0; i < coordinates.length; ++i) {
                    coordinates[i] = scaleCoordinates(coordinatesToVec3(coordinates[i]));
                }
                entity = await editor.addPolyline3d({
                    vertices: coordinates as vec3[],
                    flags: undefined,
                });
            }
            await entity.setx('$layer', layer);
            break;
        }
        case 'Polygon': {
            // TODO: add as mesh (first vec3[] is polygon and the remaining ones are holes)
            for (let i = 0; i < rawGeometry.coordinates.length; ++i) {
                const coordinates = rawGeometry.coordinates[i];
                for (let i = 0; i < coordinates.length; ++i) {
                    coordinates[i] = scaleCoordinates(coordinatesToVec3(coordinates[i]));
                }
                const entity = await editor.addPolyline3d({
                    vertices: coordinates as vec3[],
                    flags: undefined,
                });
                await entity.setx('$layer', layer);
            }
            break;
        }
        case 'MultiPoint': {
            for (let i = 0; i < rawGeometry.coordinates.length; ++i) {
                const coordinates = rawGeometry.coordinates[i];
                const entity = await editor.addCircle({
                    center: scaleCoordinates(coordinatesToVec3(coordinates)),
                    radius: 0.005,
                });
                await entity.setx('$layer', layer);
            }
            break;
        }
        case 'MultiLineString': {
            for (let i = 0; i < rawGeometry.coordinates.length; ++i) {
                const coordinates = rawGeometry.coordinates[i];
                let entity: DwgEntity | undefined;
                if (coordinates.length === 2) {
                    entity = await editor.addLine({
                        a: scaleCoordinates(coordinatesToVec3(coordinates[0])),
                        b: scaleCoordinates(coordinatesToVec3(coordinates[1])),
                    });
                } else {
                    for (let i = 0; i < coordinates.length; ++i) {
                        coordinates[i] = scaleCoordinates(coordinatesToVec3(coordinates[i]));
                    }
                    entity = await editor.addPolyline3d({
                        vertices: coordinates as vec3[],
                        flags: undefined,
                    });
                }
                await entity.setx('$layer', layer);
            }
            break;
        }
        case 'MultiPolygon': {
            for (let i = 0; i < rawGeometry.coordinates.length; ++i) {
                const polygonCoordinates = rawGeometry.coordinates[i];
                for (let j = 0; j < polygonCoordinates.length; ++j) {
                    const coordinates = polygonCoordinates[j];
                    for (let i = 0; i < coordinates.length; ++i) {
                        coordinates[i] = scaleCoordinates(coordinatesToVec3(coordinates[i]));
                    }
                    const entity = await editor.addPolyline3d({
                        vertices: coordinates as vec3[],
                        flags: undefined,
                    });
                    await entity.setx('$layer', layer);
                }
            }
            break;
        }
        default: // @ts-expect-error | possible branch
            outputs.error('Unsupported geometry type {0}', rawGeometry.type);
            break;
    }
}

function assignLayerName(layerData: DwgTypedObject, properties: Record<string, PropertyValue>, layerNames: string[], layerIDs: { next: number }): void {
    if (layerData.name === undefined) {
        for (let i = 0; i < layerNames.length; ++i) {
            const name = layerNames[i];
            const layerName = properties[name];
            if (layerName !== undefined) {
                switch (typeof layerName) {
                    case 'number':
                        if (!isFinite(layerName)) {
                            continue;
                        }
                        layerData.name = layerName.toString();
                        break;
                    case 'string':
                        if (layerName.length === 0) {
                            continue;
                        }
                        layerData.name = layerName;
                        break;
                    default:
                        if (layerName instanceof Date) {
                            if (isNaN(layerName.valueOf())) {
                                continue;
                            }
                            layerData.name = layerName.toLocaleString();
                        }
                        break;
                }
                break;
            }
        }
        if (layerData.name === undefined) {
            layerData.name = (++layerIDs.next).toString();
        }
    }
}

async function loadFeature(editor: DwgEntityEditor, drawing: Drawing, feature: Feature, layerNames: string[], layerIDs: { next: number }, outputs: OutputChannel): Promise<DwgLayer> {
    const layerData = featureProps(feature.properties, outputs);
    layerData.$type = drawing.types.itemById('SmdxElement');
    assignLayerName(layerData, feature.properties, layerNames, layerIDs);
    const layer = await drawing.layers.add(layerData as unknown as DwgLayerData);
    layer.disabled = true;
    await featureGeometry(editor, layer, feature.geometry, outputs);
    return layer;
}

async function loadShapes(editor: DwgEntityEditor, drawing: Drawing, geoJSONs: Record<string, GeoJSON>, root: DwgLayer, layerNames: string[], layerIDs: { next: number }, outputs: OutputChannel, progress: WorkerProgress): Promise<void> {
    progress.indeterminate = false;
    const names = Object.keys(geoJSONs);
    for (let i = 0; i < names.length; ++i) {
        const name = names[i];
        const geojson = geoJSONs[name];
        switch (geojson.type) {
            case 'FeatureCollection': {
                const percents = i * 100 / names.length;
                progress.label = `${Math.round(percents)}%`;
                progress.percents = percents;
                progress.details = name;
                const parent = await drawing.layers.add({
                    $type: drawing.types.itemById('SmdxElement'),
                    name,
                } as unknown as DwgLayerData);
                parent.disabled = true;
                await parent.setx('$layer', root);
                const features = geojson.features;
                for (let j = 0; j < features.length; ++j) {
                    const feature = features[j];
                    switch (feature.type) {
                        case 'Feature': {
                            const layer = await loadFeature(editor, drawing, feature, layerNames, layerIDs, outputs);
                            await layer.setx('$layer', parent);
                            break;
                        }
                        default:
                            outputs.error('Unsupported feature type {0}', feature.type);
                            break;
                    }
                }
                break;
            }
            default:
                outputs.error('Unsupported GeoJSON type {0}', geojson.type);
                break;
        }
    }
}

export default class SHPImporter implements WorkspaceImporter {
    constructor(private readonly context: Context) {}

    async import(workspace: Workspace, model: unknown): Promise<void> {
        const progress = this.context.beginProgress();
        const outputs = this.context.createOutputChannel('SHP');
        try {
            const filename = workspace.origin ?? workspace.root.title;
            outputs.info(this.context.tr('Импорт shape из {0}', filename));
            progress.indeterminate = true;
            const drawing = model as Drawing;
            const layout = drawing.layouts?.model;
            if (layout === undefined) {
                return;
            }
            progress.details = this.context.tr('Чтение файла');
            const items = await workspace.root.propfind();
            const groups = {} as Record<string, ShapeGroup>;
            await extractGroups(groups, items, outputs, progress);
            const geoJSONs = {} as Record<string, GeoJSON>;
            const propNames = {} as Record<string, Record<PropertyType, PropertyValue>>;
            await decodeGeoJSONs(geoJSONs, propNames, groups);
            const layerNames = await choosePossibleLayerNameProps(this.context, propNames);
            const layerIDs = { next: 0 };
            await drawing.layers.beginUpdate();
            const editor = layout.editor();
            await editor.beginEdit();
            try {
                const root = await drawing.layers.add({
                    $type: drawing.types.itemById('SmdxElement'),
                    name: filename,
                } as unknown as DwgLayerData);
                root.disabled = true;
                await loadShapes(editor, drawing, geoJSONs, root, layerNames, layerIDs, outputs, progress);
            } finally {
                await drawing.layers.endUpdate();
                await editor.endEdit();
            }
        } catch (uncaughtException) {
            outputs.error(uncaughtException as Error);
        } finally {
            this.context.endProgress(progress);
        }
    }
}
