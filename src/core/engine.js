/* eslint-disable */
/**
 * engine.js — UE4/UE5 .uasset / .uexp 二进制读写引擎（无 DOM，浏览器 + Node 通用）
 *
 * 由 scripts/split-legacy.mjs 从原工具 main.js 前 3968 行机械拆分而来，
 * 保持与原实现逐字节一致的行为；仅在下列位置做了加固：
 *   - globalNameMap 改为惰性读取 globalThis（模块化必需）
 *   - readFName / getUint8 等边界检查（见 core/hardening.js 的补丁说明）
 *
 * 结构：
 *   UAssetBinaryReader      基础二进制读（小端，可切 .uexp 视图）
 *   UAssetHeaderReader      包头：magic / 版本 / 表偏移 / 自定义版本
 *   UAssetNameMapReader     名称表（含 FName hash 变体）
 *   UAssetObjectReader      导入表 / 导出表
 *   UAssetPropertyReader    属性树（含 Struct/Array/Set/Map/Text 等全类型）
 *   UAssetBinaryWriter      基础写
 *   UAssetHeaderWriter      包头回写
 *   UAssetPropertyWriter    属性回写
 */
import { debugLog, debugWarn, debugError, debugInfo, isDebugEnabled } from './log.js';

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
    __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
    return value;
};

var UAssetBinaryReader = class {

    constructor(buffer) {
        __publicField(this, "view");
        __publicField(this, "uexpView", null);
        __publicField(this, "offset", 0);
        __publicField(this, "littleEndian", true);

        __publicField(this, "totalHeaderSize", 0);
        __publicField(this, "uexpStartOffset", 0);
        __publicField(this, "isUsingUexp", false);
        this.view = new DataView(buffer);
    }

    setUexpBuffer(uexpBuffer, totalHeaderSize) {
        this.uexpView = new DataView(uexpBuffer);
        this.totalHeaderSize = totalHeaderSize;
        this.uexpStartOffset = totalHeaderSize;
    }

    getCurrentView() {
        if (this.isUsingUexp && this.uexpView) {
            return this.uexpView;
        }
        return this.view;
    }

    getCurrentOffset() {
        return this.offset;
    }

    readFromCorrectBuffer(byteLength) {
        if (this.isUsingUexp && this.uexpView) {
            const bytes = new Uint8Array(this.uexpView.buffer, this.offset, byteLength);
            this.offset += byteLength;
            return bytes;
        } else {
            const bytes = new Uint8Array(this.view.buffer, this.offset, byteLength);
            this.offset += byteLength;
            return bytes;
        }
    }

    readInt32() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const value = view.getInt32(currentOffset, this.littleEndian);
        this.offset += 4;
        return value;
    }

    readUInt32() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const value = view.getUint32(currentOffset, this.littleEndian);
        this.offset += 4;
        return value;
    }

    readInt16() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const value = view.getInt16(currentOffset, this.littleEndian);
        this.offset += 2;
        return value;
    }

    readUInt16() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const value = view.getUint16(currentOffset, this.littleEndian);
        this.offset += 2;
        return value;
    }

    readUInt8() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const value = view.getUint8(currentOffset);
        this.offset += 1;
        return value;
    }

    readInt8() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const value = view.getInt8(currentOffset);
        this.offset += 1;
        return value;
    }

    readInt64() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const low = view.getUint32(currentOffset, this.littleEndian);
        const high = view.getInt32(currentOffset + 4, this.littleEndian);
        this.offset += 8;
        return high * 4294967296 + low;
    }

    readDouble() {
        const view = this.getCurrentView();
        const currentOffset = this.getCurrentOffset();
        const value = view.getFloat64(currentOffset, this.littleEndian);
        this.offset += 8;
        return value;
    }

    readFName(nameMap) {
        const index = this.readInt32();
        const number = this.readInt32();
        if (index >= 0 && index < nameMap.length) {
            const name = nameMap[index];
            if (number !== 0) {
                return `${name}_${number - 1}`;
            }
            return name;
        }
        return `Unknown_${index}_${number}`;
    }

    readFString() {
        const length = this.readInt32();
        if (length === 0) {
            return "";
        }
        if (length < 0) {
            const byteLength = -length * 2;
            const bytes = this.readFromCorrectBuffer(byteLength);
            const stringBytes = bytes.slice(0, -2);
            return new TextDecoder("utf-16le").decode(stringBytes);
        } else {
            const bytes = this.readFromCorrectBuffer(length - 1);
            this.offset += 1;
            return new TextDecoder("latin1").decode(bytes);
        }
    }

    readGuid() {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            bytes[i] = this.readUInt8();
        }
        const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
    }

    getOffset() {
        if (this.isUsingUexp) {
            return this.offset + this.totalHeaderSize;
        }
        return this.offset;
    }

    setOffset(offset) {
        if (this.uexpView && offset >= this.totalHeaderSize) {
            this.isUsingUexp = true;
            this.offset = offset - this.totalHeaderSize;
        } else {
            this.isUsingUexp = false;
            this.offset = offset;
        }
    }

    getBufferSize() {
        if (this.uexpView) {
            return this.totalHeaderSize + this.uexpView.buffer.byteLength;
        }
        return this.view.buffer.byteLength;
    }
};

var UAssetHeaderReader = class extends UAssetBinaryReader {
    constructor(buffer) {
        super(buffer);
    }
    read() {
        // Track positions of offset fields for precise binary patching
        const offsetPositions = {};

        const tag = this.readUInt32();
        if (tag !== 2653586369) {
            throw new Error(`Invalid UAsset magic number. Expected 0x9E2A83C1, got 0x${tag.toString(16).toUpperCase()}`);
        }
        const legacyFileVersion = this.readInt32();
        const isDeltaForce = legacyFileVersion === -4613;
        const legacyUE3Version = this.readInt32();
        const fileVersionUE4 = this.readInt32();
        const fileVersionLicenseeUE4 = this.readInt32();
        let effectiveVersion = fileVersionUE4;
        const rawFileVersionUE4 = fileVersionUE4;
        if (fileVersionUE4 === 0) {
            effectiveVersion = 513;
        }
        const customVersionsCount = this.readInt32();
        const customVersions = [];
        for (let i = 0; i < customVersionsCount; i++) {
            const guid2 = this.readGuid();
            const version = this.readInt32();
            customVersions.push({
                key: guid2,
                version
            });
        }

        // Track totalHeaderSize position
        offsetPositions.totalHeaderSize = this.offset;
        const totalHeaderSize = this.readInt32();

        const folderName = this.readFString();
        const packageFlags = this.readUInt32();
        const nameCount = this.readInt32();

        // Track nameOffset position
        offsetPositions.nameOffset = this.offset;
        const nameOffset = this.readInt32();

        let localizationId = "";
        if (!isDeltaForce && rawFileVersionUE4 !== 0 && rawFileVersionUE4 >= 459) {
            localizationId = this.readFString();
        }
        let gatherableTextDataCount = 0;
        let gatherableTextDataOffset = 0;
        if (effectiveVersion >= 456) {
            gatherableTextDataCount = this.readInt32();
            offsetPositions.gatherableTextDataOffset = this.offset;
            gatherableTextDataOffset = this.readInt32();
        }
        const exportCount = this.readInt32();

        // Track exportOffset position
        offsetPositions.exportOffset = this.offset;
        const exportOffset = this.readInt32();

        const importCount = this.readInt32();

        // Track importOffset position
        offsetPositions.importOffset = this.offset;
        const importOffset = this.readInt32();

        // Track dependsOffset position
        offsetPositions.dependsOffset = this.offset;
        const dependsOffset = this.readInt32();

        let softPackageReferencesCount = 0;
        let softPackageReferencesOffset = 0;
        if (effectiveVersion >= 384) {
            softPackageReferencesCount = this.readInt32();
            offsetPositions.softPackageReferencesOffset = this.offset;
            softPackageReferencesOffset = this.readInt32();
        }
        let searchableNamesOffset = 0;
        if (effectiveVersion >= 510) {
            offsetPositions.searchableNamesOffset = this.offset;
            searchableNamesOffset = this.readInt32();
        }

        // Track thumbnailTableOffset position
        offsetPositions.thumbnailTableOffset = this.offset;
        const thumbnailTableOffset = this.readInt32();

        const guid = this.readGuid();
        if (isDeltaForce) {
            this.offset += 8;
        }
        const generationsCount = this.readInt32();
        const generations = [];
        for (let i = 0; i < generationsCount; i++) {
            generations.push({
                exportCount: this.readInt32(),
                nameCount: this.readInt32()
            });
        }
        const savedByEngineVersion = this.readEngineVersion();
        let compatibleWithEngineVersion = null;
        if (effectiveVersion >= 336) {
            compatibleWithEngineVersion = this.readEngineVersion();
        }
        const compressionFlags = this.readUInt32();
        const compressedChunksCount = this.readInt32();
        const compressedChunks = [];
        for (let i = 0; i < compressedChunksCount; i++) {
            compressedChunks.push({
                uncompressedOffset: this.readInt32(),
                uncompressedSize: this.readInt32(),
                compressedOffset: this.readInt32(),
                compressedSize: this.readInt32()
            });
        }
        const packageSource = this.readUInt32();
        const additionalPackagesCount = this.readInt32();
        const additionalPackagesToCook = [];
        for (let i = 0; i < additionalPackagesCount; i++) {
            additionalPackagesToCook.push(this.readFString());
        }

        // Track assetRegistryDataOffset position
        offsetPositions.assetRegistryDataOffset = this.offset;
        const assetRegistryDataOffset = this.readInt32();

        // Track bulkDataStartOffset position
        offsetPositions.bulkDataStartOffset = this.offset;
        const bulkDataStartOffset = this.readInt32();

        let worldTileInfoDataOffset = 0;
        if (effectiveVersion >= 224) {
            offsetPositions.worldTileInfoDataOffset = this.offset;
            worldTileInfoDataOffset = this.readInt32();
        }
        let chunkIDs = [];
        if (effectiveVersion >= 326) {
            const chunkIDsCount = this.readInt32();
            chunkIDs = [];
            for (let i = 0; i < chunkIDsCount; i++) {
                chunkIDs.push(this.readInt32());
            }
        } else if (effectiveVersion >= 278) {
            chunkIDs = [this.readInt32()];
        }
        let preloadDependencyCount = 0;
        let preloadDependencyOffset = 0;
        if (effectiveVersion >= 365) {
            preloadDependencyCount = this.readInt32();
            offsetPositions.preloadDependencyOffset = this.offset;
            preloadDependencyOffset = this.readInt32();
        }
        return {
            isDeltaForce,
            tag,
            legacyFileVersion,
            legacyUE3Version,
            fileVersionUE4: effectiveVersion,
            fileVersionLicenseeUE4,
            rawFileVersionUE4,
            customVersions,
            totalHeaderSize,
            folderName,
            packageFlags,
            nameCount,
            nameOffset,
            localizationId,
            gatherableTextDataCount,
            gatherableTextDataOffset,
            exportCount,
            exportOffset,
            importCount,
            importOffset,
            dependsOffset,
            softPackageReferencesCount,
            softPackageReferencesOffset,
            searchableNamesOffset,
            thumbnailTableOffset,
            guid,
            generations,
            savedByEngineVersion,
            compatibleWithEngineVersion,
            compressionFlags,
            compressedChunks,
            packageSource,
            additionalPackagesToCook,
            assetRegistryDataOffset,
            bulkDataStartOffset,
            worldTileInfoDataOffset,
            chunkIDs,
            preloadDependencyCount,
            preloadDependencyOffset,
            // NEW: Include offset positions for precise binary patching
            offsetPositions
        };
    }
    readEngineVersion() {
        const major = this.readUInt16();
        const minor = this.readUInt16();
        const patch = this.readUInt16();
        const changelist = this.readUInt32();
        const branch = this.readFString();
        return {
            major,
            minor,
            patch,
            changelist,
            branch
        };
    }
};

var UAssetNameMapReader = class extends UAssetBinaryReader {
    constructor(buffer, fileVersionUE4 = 513) {
        super(buffer);
        __publicField(this, "fileVersionUE4");
        this.fileVersionUE4 = fileVersionUE4;
    }

    read(nameOffset, nameCount, nameSectionEnd) {
        const names = [];
        this.setOffset(nameOffset);
        const endOffset = nameSectionEnd ?? this.getBufferSize();
        for (let i = 0; i < nameCount; i++) {
            try {
                const name = this.readFString();
                if (this.fileVersionUE4 >= 504) {
                    this.readUInt16();
                    this.readUInt16();
                }
                names.push(name);
            } catch (e) {
                debugWarn(`NameMap read failed at ${i}: ${e.message}`);
                break;
            }
        }
        if (names.length < nameCount) {
            debugWarn(`NameMap short: expected ${nameCount}, got ${names.length}`);
        }
        return names;
    }
};

var UAssetObjectReader = class extends UAssetBinaryReader {
    constructor(buffer, nameMap, fileVersionUE4 = 513) {
        super(buffer);
        __publicField(this, "nameMap");
        __publicField(this, "fileVersionUE4");
        this.nameMap = nameMap;
        this.fileVersionUE4 = fileVersionUE4;
    }

    readImports(count) {
        const imports = [];
        for (let i = 0; i < count; i++) {
            const classPackageIndex = this.readInt32();
            const classPackageNumber = this.readInt32();
            const classPackageName = this.getNameFromIndex(classPackageIndex, classPackageNumber);
            const classNameIndex = this.readInt32();
            const classNameNumber = this.readInt32();
            const className = this.getNameFromIndex(classNameIndex, classNameNumber);
            const outerIndex = this.readInt32();
            const objectNameIndex = this.readInt32();
            const objectNameNumber = this.readInt32();
            const objectName = this.getNameFromIndex(objectNameIndex, objectNameNumber);
            imports.push({
                classPackageIndex,
                classPackageName,
                classNameIndex,
                className,
                outerIndex,
                objectNameIndex,
                objectName
            });
        }
        return imports;
    }

    readExports(count) {
        const exports = [];
        for (let i = 0; i < count; i++) {
            const classIndex = this.readInt32();
            const superIndex = this.readInt32();
            const templateIndex = this.readInt32();
            const outerIndex = this.readInt32();
            const objectNameIndex = this.readInt32();
            const objectNameNumber = this.readInt32();
            const objectName = this.getNameFromIndex(objectNameIndex, objectNameNumber);
            const objectFlags = this.readUInt32();
            let serialSize;
            let serialOffset;
            if (this.fileVersionUE4 < 508) {
                serialSize = this.readInt32();
                serialOffset = this.readInt32();
            } else {
                serialSize = this.readInt64();
                serialOffset = this.readInt64();
            }
            const bForcedExport = this.readInt32() !== 0;
            const bNotForClient = this.readInt32() !== 0;
            const bNotForServer = this.readInt32() !== 0;
            const packageGuid = this.readGuid();
            const packageFlags = this.readUInt32();
            let bNotAlwaysLoadedForEditorGame = false;
            if (this.fileVersionUE4 >= 365) {
                bNotAlwaysLoadedForEditorGame = this.readInt32() !== 0;
            }
            let bIsAsset = false;
            if (this.fileVersionUE4 >= 465) {
                bIsAsset = this.readInt32() !== 0;
            }
            let firstExportDependency = 0;
            let serializationBeforeSerializationDependencies = 0;
            let createBeforeSerializationDependencies = 0;
            let serializationBeforeCreateDependencies = 0;
            let createBeforeCreateDependencies = 0;
            if (this.fileVersionUE4 >= 507) {
                firstExportDependency = this.readInt32();
                serializationBeforeSerializationDependencies = this.readInt32();
                createBeforeSerializationDependencies = this.readInt32();
                serializationBeforeCreateDependencies = this.readInt32();
                createBeforeCreateDependencies = this.readInt32();
            }
            exports.push({
                classIndex,
                superIndex,
                templateIndex,
                outerIndex,
                objectNameIndex,
                objectName,
                objectFlags,
                serialSize,
                serialOffset,
                bForcedExport,
                bNotForClient,
                bNotForServer,
                packageGuid,
                packageFlags,
                bNotAlwaysLoadedForEditorGame,
                bIsAsset,
                firstExportDependency,
                serializationBeforeSerializationDependencies,
                createBeforeSerializationDependencies,
                serializationBeforeCreateDependencies,
                createBeforeCreateDependencies
            });
        }
        return exports;
    }

    getNameFromIndex(index, number) {
        if (index >= 0 && index < this.nameMap.length) {
            const name = this.nameMap[index];
            if (number !== 0) {
                return `${name}_${number - 1}`;
            }
            return name;
        }
        return `Unknown_${index}_${number}`;
    }
};

var UAssetPropertyReader = class extends UAssetBinaryReader {
    constructor(buffer, nameMap, imports, exports, totalHeaderSize, uexpBuffer, enableDebug = false) {
        super(buffer);
        __publicField(this, "nameMap");
        __publicField(this, "imports");
        __publicField(this, "exports");
        __publicField(this, "enableDebug");
        this.nameMap = nameMap;
        this.imports = imports;
        this.exports = exports;
        this.totalHeaderSize = totalHeaderSize;
        this.enableDebug = enableDebug;
        if (uexpBuffer) {
            this.setUexpBuffer(uexpBuffer, totalHeaderSize);
        }
    }

    log(msg) {
        if (this.enableDebug) {
            debugLog(`[READ] ${msg}`, "color: #00ffff");
        }
    }
    formatHex(offset) {
        return `0x${offset.toString(16).toUpperCase().padStart(8, "0")}`;
    }
    formatGuid(guid) {
        if (!guid || guid === "00000000-0000-0000-0000-000000000000") {
            return "00000000-0000-0000-0000-000000000000 (all zeros)";
        }
        return guid;
    }

    formatHexDump(bytes, startOffset = 0) {
        const lines = [];
        for (let i = 0; i < bytes.length; i += 16) {
            const chunk = bytes.slice(i, Math.min(i + 16, bytes.length));
            const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
            const ascii = Array.from(chunk).map((b) => b >= 32 && b < 127 ? String.fromCharCode(b) : ".").join("");
            const offset = startOffset + i;
            lines.push(`${this.formatHex(offset)}  ${hex.padEnd(48)}  ${ascii}`);
        }
        return lines.join("\n");
    }
    getObjectName(index) {
        if (index === 0)
            return "None";
        if (index < 0) {
            const importIdx = -index - 1;
            return this.imports && this.imports[importIdx] ? this.imports[importIdx].objectName : `Import_${importIdx}`;
        } else {
            const exportIdx = index - 1;
            return this.exports && this.exports[exportIdx] ? this.exports[exportIdx].objectName : `Export_${exportIdx}`;
        }
    }
    readStruct(structName, size) {
        const startOffset = this.getOffset();
        if (this.enableDebug)
            this.log(`  -> Reading Struct '${structName}' (Size: ${size}) @ ${this.formatHex(startOffset)}`);
        if (structName === "RichCurve") {
            if (this.enableDebug) {
                this.log(`  -> RichCurve detected: Reading as raw binary blob (${size} bytes) to prevent data loss`);
            }
            const bufferSize = this.getBufferSize();
            const maxReadableBytes = bufferSize - startOffset;
            const bytesToRead = Math.max(0, Math.min(size, maxReadableBytes));
            let rawBytes;
            if (bytesToRead > 0 && size > 0) {
                try {
                    rawBytes = this.readBytes(bytesToRead);
                    if (rawBytes.length < size) {
                        const paddedBytes = new Uint8Array(size);
                        paddedBytes.set(rawBytes, 0);
                        rawBytes = paddedBytes;
                    }
                } catch (error) {
                    debugWarn(`[Reader] RichCurve raw byte read failed. Creating zero-filled array (${size} bytes). Reason: ${error}`);
                    rawBytes = new Uint8Array(size);
                }
            } else {
                debugError(`[Reader] Critical: Cannot read RichCurve bytes. Size: ${size}, Available: ${maxReadableBytes}`);
                rawBytes = new Uint8Array(Math.max(0, size));
            }
            this.setOffset(startOffset + size);
            return rawBytes;
        }
        if (structName === "Guid") {
            if (this.enableDebug) {
                this.log(`  -> Guid detected: Reading as raw binary blob (${size} bytes) to prevent consuming parent terminator`);
            }
            const bufferSize = this.getBufferSize();
            const maxReadableBytes = bufferSize - startOffset;
            const bytesToRead = Math.max(0, Math.min(size, maxReadableBytes));
            let rawBytes;
            if (bytesToRead > 0 && size > 0) {
                try {
                    rawBytes = this.readBytes(bytesToRead);
                    if (rawBytes.length < size) {
                        const paddedBytes = new Uint8Array(size);
                        paddedBytes.set(rawBytes, 0);
                        rawBytes = paddedBytes;
                    }
                } catch (error) {
                    debugWarn(`[Reader] Guid raw byte read failed. Creating zero-filled array (${size} bytes). Reason: ${error}`);
                    rawBytes = new Uint8Array(size);
                }
            } else {
                debugError(`[Reader] Critical: Cannot read Guid bytes. Size: ${size}, Available: ${maxReadableBytes}`);
                rawBytes = new Uint8Array(Math.max(0, size));
            }
            this.setOffset(startOffset + size);
            return rawBytes;
        }
        if (structName === "Vector" || structName === "Rotator")
            return { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() };
        if (structName === "Vector2D")
            return { x: this.readFloat(), y: this.readFloat() };
        if (structName === "Quat" || structName === "Vector4")
            return { x: this.readFloat(), y: this.readFloat(), z: this.readFloat(), w: this.readFloat() };
        if (structName === "Color")
            return { b: this.readUInt8(), g: this.readUInt8(), r: this.readUInt8(), a: this.readUInt8() };
        if (structName === "LinearColor")
            return { r: this.readFloat(), g: this.readFloat(), b: this.readFloat(), a: this.readFloat() };
        if (structName === "IntPoint")
            return { x: this.readInt32(), y: this.readInt32() };
        if (structName === "Box") {
            // FBox: Min(Vector), Max(Vector), IsValid(uchar) -> 12 + 12 + 1 = 25 bytes
            const min = { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() };
            const max = { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() };
            const isValid = this.readUInt8();
            return { min, max, isValid };
        }
        if (structName === "Box2D") {
            // FBox2D: Min(Vector2D), Max(Vector2D), IsValid(uchar) -> 8 + 8 + 1 = 17 bytes
            const min = { x: this.readFloat(), y: this.readFloat() };
            const max = { x: this.readFloat(), y: this.readFloat() };
            const isValid = this.readUInt8();
            return { min, max, isValid };
        }
        // ========================================================================================
        // PHYSICS COLLISION SHAPES (Native Serialization) - Used in KAggregateGeom
        // ========================================================================================
        // FKShapeElem base fields (shared by all):
        //   - RestOffset (float, 4 bytes) - Deprecated in newer UE versions but may still be present
        //   - Name (FName, 8 bytes) - User-defined name for the shape
        //   - bContributeToMass (bool, 1 byte) - Whether this shape contributes to mass calculation
        //   - CollisionEnabled (uint8, 1 byte) - ECollisionEnabled::Type
        //
        // Note: The exact serialization format varies between UE4 versions. We use tagged property
        // parsing combined with fallback to handle different formats.

        // FKBoxElem: Box collision shape
        if (structName === "FKBoxElem" || structName === "KBoxElem") {
            if (this.enableDebug) {
                this.log(`  -> FKBoxElem detected: Reading native struct (Size: ${size} bytes)`);
            }
            // Try to parse as tagged properties first (UE4.25+)
            try {
                const structEnd = startOffset + size;
                const properties = this.readProperties(structEnd);
                if (properties.length > 0) {
                    // Ensure we've consumed exactly the right amount
                    const consumed = this.getOffset() - startOffset;
                    if (consumed <= size + 8) {
                        return properties;
                    }
                }
                throw new Error("Tagged property parsing returned no properties");
            } catch (e) {
                // Fallback: Read as raw binary
                this.setOffset(startOffset);
                if (this.enableDebug) {
                    this.log(`  -> FKBoxElem: Falling back to raw binary (${size} bytes). Reason: ${e.message}`);
                }
                const rawBytes = this.readBytes(size);
                return rawBytes;
            }
        }

        // FKSphylElem: Capsule (Sphyl) collision shape
        if (structName === "FKSphylElem" || structName === "KSphylElem") {
            if (this.enableDebug) {
                this.log(`  -> FKSphylElem detected: Reading native struct (Size: ${size} bytes)`);
            }
            // Try to parse as tagged properties first (UE4.25+)
            try {
                const structEnd = startOffset + size;
                const properties = this.readProperties(structEnd);
                if (properties.length > 0) {
                    const consumed = this.getOffset() - startOffset;
                    if (consumed <= size + 8) {
                        return properties;
                    }
                }
                throw new Error("Tagged property parsing returned no properties");
            } catch (e) {
                // Fallback: Read as raw binary
                this.setOffset(startOffset);
                if (this.enableDebug) {
                    this.log(`  -> FKSphylElem: Falling back to raw binary (${size} bytes). Reason: ${e.message}`);
                }
                const rawBytes = this.readBytes(size);
                return rawBytes;
            }
        }

        // FKSphereElem: Sphere collision shape
        if (structName === "FKSphereElem" || structName === "KSphereElem") {
            if (this.enableDebug) {
                this.log(`  -> FKSphereElem detected: Reading native struct (Size: ${size} bytes)`);
            }
            try {
                const structEnd = startOffset + size;
                const properties = this.readProperties(structEnd);
                if (properties.length > 0) {
                    const consumed = this.getOffset() - startOffset;
                    if (consumed <= size + 8) {
                        return properties;
                    }
                }
                throw new Error("Tagged property parsing returned no properties");
            } catch (e) {
                this.setOffset(startOffset);
                if (this.enableDebug) {
                    this.log(`  -> FKSphereElem: Falling back to raw binary (${size} bytes). Reason: ${e.message}`);
                }
                const rawBytes = this.readBytes(size);
                return rawBytes;
            }
        }

        // FKTaperedCapsuleElem: Tapered capsule collision shape
        if (structName === "FKTaperedCapsuleElem" || structName === "KTaperedCapsuleElem") {
            if (this.enableDebug) {
                this.log(`  -> FKTaperedCapsuleElem detected: Reading native struct (Size: ${size} bytes)`);
            }
            try {
                const structEnd = startOffset + size;
                const properties = this.readProperties(structEnd);
                if (properties.length > 0) {
                    const consumed = this.getOffset() - startOffset;
                    if (consumed <= size + 8) {
                        return properties;
                    }
                }
                throw new Error("Tagged property parsing returned no properties");
            } catch (e) {
                this.setOffset(startOffset);
                if (this.enableDebug) {
                    this.log(`  -> FKTaperedCapsuleElem: Falling back to raw binary (${size} bytes). Reason: ${e.message}`);
                }
                const rawBytes = this.readBytes(size);
                return rawBytes;
            }
        }

        // FKConvexElem: Convex mesh collision shape
        if (structName === "FKConvexElem" || structName === "KConvexElem") {
            if (this.enableDebug) {
                this.log(`  -> FKConvexElem detected: Reading native struct (Size: ${size} bytes)`);
            }
            // Convex elements often contain vertex arrays and are complex
            // Read as raw binary to preserve data integrity
            const rawBytes = this.readBytes(size);
            return rawBytes;
        }
        if (["ColorMaterialInput", "ScalarMaterialInput", "VectorMaterialInput", "ShadingModelMaterialInput"].includes(structName)) {
            if (this.enableDebug) this.log(`  -> Reading MaterialInput '${structName}' as Native Struct`);

            const expressionIndex = this.readInt32();
            const outputIndex = this.readInt32();
            const inputName = this.readFName(this.nameMap);
            const mask = this.readInt32();
            const maskR = this.readInt32();
            const maskG = this.readInt32();
            const maskB = this.readInt32();
            const maskA = this.readInt32();

            let constant;
            let paddingBytes = null;
            // Base size so far: 4+4+8+4+4+4+4+4 = 36 bytes

            if (structName === "ColorMaterialInput") {
                // Read FColor (4 bytes)
                constant = { b: this.readUInt8(), g: this.readUInt8(), r: this.readUInt8(), a: this.readUInt8() };
            } else if (structName === "ScalarMaterialInput") {
                // Read Float (4 bytes)
                constant = this.readFloat();
            } else if (structName === "VectorMaterialInput") {
                // Read FVector (12 bytes)
                constant = { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() };
            } else if (structName === "ShadingModelMaterialInput") {
                // Read UInt32 (4 bytes)
                constant = this.readUInt32();
            }

            // Consume remaining padding bytes to match 'size'
            const currentPos = this.getOffset();
            const expectedEnd = startOffset + size;
            if (currentPos < expectedEnd) {
                paddingBytes = this.readBytes(expectedEnd - currentPos);
            }

            return {
                Expression: this.getObjectName(expressionIndex),
                rawExpressionIndex: expressionIndex,
                OutputIndex: outputIndex,
                InputName: inputName,
                Mask: mask,
                MaskR: maskR,
                MaskG: maskG,
                MaskB: maskB,
                MaskA: maskA,
                Constant: constant,
                _padding: paddingBytes // Internal use
            };
        }
        if (structName === "Transform") {
            const nativeTransformSize = 40;
            const taggedThreshold = 50;
            if (size > taggedThreshold) {
                if (this.enableDebug) {
                    this.log(`  -> FTransform detected as Tagged Struct (Size: ${size} bytes, > ${taggedThreshold} bytes threshold)`);
                }
            } else {
                if (this.enableDebug) {
                    this.log(`  -> FTransform detected as Native Struct (Size: ${size} bytes, <= ${taggedThreshold} bytes threshold)`);
                }
                return {
                    rotation: { x: this.readFloat(), y: this.readFloat(), z: this.readFloat(), w: this.readFloat() },
                    translation: { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() },
                    scale3D: { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() }
                };
            }
        }
        try {
            const structEnd = startOffset + size;
            if (size > 0 && size < 4) {
                throw new Error("Struct too small for properties");
            }
            // Attempt to read as standard property list
            const properties = this.readProperties(structEnd);
            if (properties.length === 0 && size > 0 && this.getOffset() < structEnd) {
                throw new Error("No properties parsed but size remains");
            }
            // Verify we consumed the expected amount of data
            const consumed = this.getOffset() - startOffset;
            if (consumed > size + 4) {
                // We read too much, likely wrong format
                throw new Error(`Property reading consumed ${consumed} bytes but struct size is ${size}`);
            }
            // CRITICAL: If we read less than the struct size, there may be padding
            // But we should NOT read the padding here - it's handled by the caller
            // So we keep the offset where readProperties left it (at None terminator)
            // The caller will handle alignment/padding

            // Capture original bytes for raw preservation mode
            const currentOffset = this.getOffset();
            this.setOffset(startOffset);
            const originalBytes = this.readBytes(size);
            // Restore offset to where properties ended (not struct end, in case of padding)
            this.setOffset(currentOffset);
            // Attach originalBytes to the properties array
            if (Array.isArray(properties)) {
                properties._rawBytes = originalBytes;
            }
            return properties;
        } catch (e) {
            // Fallback: Read as raw binary blob
            if (this.enableDebug) {
                debugWarn(`[Reader] Struct '${structName}' parsing failed. Falling back to raw binary (${size} bytes). Reason: ${e.message || e}`);
            }
            this.setOffset(startOffset);
            const maxReadableBytes = this.getBufferSize() - startOffset;
            const bytesToRead = Math.max(0, Math.min(size, maxReadableBytes));
            let rawBytes;
            if (bytesToRead > 0 && size > 0 && size < 1024 * 1024 * 10) {
                // Limit to 10MB to prevent memory issues
                try {
                    rawBytes = this.readBytes(bytesToRead);
                    if (rawBytes.length < size) {
                        // Pad with zeros if we couldn't read the full size
                        const paddedBytes = new Uint8Array(size);
                        paddedBytes.set(rawBytes, 0);
                        rawBytes = paddedBytes;
                    }
                } catch (fallbackError) {
                    debugWarn(`[Reader] Struct raw byte read failed for '${structName}'. Creating zero-filled array (${size} bytes). Reason: ${fallbackError.message || fallbackError}`);
                    rawBytes = new Uint8Array(Math.max(0, size));
                }
            } else {
                if (size >= 1024 * 1024 * 10) {
                    debugError(`[Reader] Struct '${structName}' size too large (${size} bytes). Limiting to available bytes.`);
                } else {
                    debugError(`[Reader] Critical: Cannot read struct bytes for '${structName}'. Size: ${size}, Available: ${maxReadableBytes}`);
                }
                rawBytes = new Uint8Array(Math.max(0, Math.min(size, maxReadableBytes)));
            }
            this.setOffset(startOffset + size);
            return rawBytes;
        }
    }
    readSingleValue(type, size) {
        switch (type) {
            case "BoolProperty":
                return this.readUInt8() !== 0;
            case "IntProperty":
                return this.readInt32();
            case "UInt32Property":
                return this.readUInt32();
            case "UInt64Property":
                const low = this.readUInt32();
                const high = this.readUInt32();
                return `${high.toString(16)}${low.toString(16).padStart(8, "0")}`;
            case "FloatProperty":
                return this.readFloat();
            case "DoubleProperty":
                return this.readDouble();
            case "StrProperty":
            case "NameProperty":
                return this.readFName(this.nameMap);
            case "ObjectProperty":
                return this.getObjectName(this.readInt32());
            case "SoftObjectProperty":
                const softAssetPathName = this.readFName(this.nameMap);
                const softSubPathString = this.readFString();
                return {
                    assetPathName: softAssetPathName,
                    subPathString: softSubPathString
                };
            case "ByteProperty":
            case "EnumProperty":
                if (size === 8)
                    return this.readFName(this.nameMap);
                return this.readUInt8();
            case "DelegateProperty":
                const delegateObject = this.readInt32();
                const delegateFunctionName = this.readFName(this.nameMap);
                return {
                    object: this.getObjectName(delegateObject),
                    functionName: delegateFunctionName,
                    rawIndex: delegateObject
                };
            case "MulticastDelegateProperty":
                const mcCount = this.readInt32();
                const mcElements = [];
                for (let i = 0; i < mcCount; i++) {
                    const obj = this.readInt32();
                    const func = this.readFName(this.nameMap);
                    mcElements.push({
                        object: this.getObjectName(obj),
                        functionName: func,
                        rawIndex: obj
                    });
                }
                return mcElements;
            default:
                return `Unsupported(${type})`;
        }
    }
    readBytes(length) {
        return this.readFromCorrectBuffer(length);
    }
    readDataTableRows() {
        const start = this.getOffset();
        this.readInt32();
        const rowCount = this.readInt32();
        const rows = [];
        for (let i = 0; i < rowCount; i++) {
            const nameIdx = this.readInt32();
            const nameNum = this.readInt32();
            const tmap = this.nameMap || (typeof globalThis !== "undefined" && globalThis.globalNameMap) || [];
            const nm = (nameIdx >= 0 && nameIdx < tmap.length) ? tmap[nameIdx] : ("#" + nameIdx);
            const props = this.readProperties();
            rows.push({ name: nameNum > 0 ? nm + "_" + (nameNum - 1) : nm, nameIdx, nameNum, props });
        }
        return { start, rowCount, rows };
    }

    readProperties(endOffset) {
        const properties = [];
        while (true) {
            const currentPos = this.getOffset();
            if (endOffset !== void 0 && currentPos >= endOffset)
                break;
            if (endOffset !== void 0 && endOffset - currentPos < 8) {
                break;
            }
            let name;
            let type;
            let size;
            let arrayIndex;
            try {
                name = this.readFName(this.nameMap);
                if (name === "None") {
                    if (this.enableDebug)
                        this.log(`@ ${this.formatHex(currentPos)} Found 'None' Terminator.`);
                    break;
                }
                if (name.startsWith("Unknown_")) {
                    if (this.enableDebug)
                        this.log(`@ ${this.formatHex(currentPos)} Found Unknown Name '${name}'. Expecting Sync Loss.`);
                    throw new Error(`Sync Loss Detected: Unknown Name ${name}`);
                }
                type = this.readFName(this.nameMap);
                size = this.readInt32();
                arrayIndex = this.readInt32();
                if (size < 0 || size > 100 * 1024 * 1024) {
                    throw new Error(`Invalid property size: ${size}`);
                }
            } catch (headerErr) {
                throw headerErr;
            }
            if (this.enableDebug) {
                this.log(`@ ${this.formatHex(currentPos)} | Prop: ${name} | Type: ${type} | Size: ${size} | Index: ${arrayIndex}`);
            }
            let structName;
            let innerType;
            let valueType;
            let enumName;
            let boolValue;
            let boolOffset = void 0;
            let structHeaderGuid = void 0;
            let propertyGuid = void 0;
            try {
                if (type === "StructProperty") {
                    structName = this.readFName(this.nameMap);
                    if (this.enableDebug)
                        this.log(`  -> Struct Header Name: ${structName}`);
                    structHeaderGuid = this.readGuid();
                    if (this.enableDebug)
                        this.log(`  -> Struct Header GUID: ${structHeaderGuid}`);
                } else if (type === "ArrayProperty") {
                    innerType = this.readFName(this.nameMap);
                } else if (type === "ByteProperty" || type === "EnumProperty") {
                    enumName = this.readFName(this.nameMap);
                } else if (type === "BoolProperty") {
                    boolOffset = this.getOffset();
                    boolValue = this.readUInt8() !== 0;
                    if (this.enableDebug)
                        this.log(`  -> Bool Value (Header): ${boolValue}`);
                } else if (type === "MapProperty") {
                    innerType = this.readFName(this.nameMap);
                    valueType = this.readFName(this.nameMap);
                } else if (type === "SetProperty") {
                    innerType = this.readFName(this.nameMap);
                } else if (type === "SoftObjectProperty") {
                }
                const hasPropertyGuid = this.readUInt8();
                if (this.enableDebug)
                    this.log(`  -> HasPropertyGuid Flag: ${hasPropertyGuid}`);
                if (hasPropertyGuid !== 0) {
                    propertyGuid = this.readGuid();
                    if (this.enableDebug)
                        this.log(`  -> PropertyGUID Read: ${propertyGuid}`);
                }
            } catch (headerDetailErr) {
                throw headerDetailErr;
            }
            const startOffset = this.getOffset();
            let value = null;
            let isExpandable = false;
            let rawIndex;
            let arrayStructInfo = void 0;
            let usedRawBytesFallback = false;
            try {
                switch (type) {
                    case "BoolProperty":
                        value = boolValue;
                        break;
                    case "IntProperty":
                        value = this.readInt32();
                        break;
                    case "UInt32Property":
                        value = this.readUInt32();
                        break;
                    case "UInt64Property":
                        const l = this.readUInt32();
                        const h = this.readUInt32();
                        value = `${h.toString(16)}${l.toString(16).padStart(8, "0")}`;
                        break;
                    case "FloatProperty":
                        value = this.readFloat();
                        break;
                    case "DoubleProperty":
                        value = this.readDouble();
                        break;
                    case "StrProperty":
                        value = this.readFString();
                        break;
                    case "NameProperty":
                        value = this.readFName(this.nameMap);
                        break;
                    case "ObjectProperty":
                        rawIndex = this.readInt32();
                        value = this.getObjectName(rawIndex);
                        break;
                    case "SoftObjectProperty":
                        const assetPathName = this.readFName(this.nameMap);
                        const subPathString = this.readFString();
                        value = {
                            assetPathName,
                            subPathString
                        };
                        if (this.enableDebug) {
                            this.log(`  -> SoftObjectProperty: AssetPathName="${assetPathName}", SubPathString="${subPathString}"`);
                        }
                        break;
                    case "TextProperty":
                        const flags = this.readUInt32();
                        const historyType = this.readInt8();
                        if (this.enableDebug) {
                            this.log(`  -> FText: Flags=${flags}, HistoryType=${historyType}`);
                        }
                        if (historyType === -1) {
                            value = {
                                flags,
                                historyType,
                                namespace: "",
                                key: "",
                                sourceString: ""
                            };
                            if (this.enableDebug) {
                                this.log(`  -> FText: HistoryType=-1 (None), empty text`);
                            }
                        } else if (historyType === 0) {
                            const namespace = this.readFString();
                            const key = this.readFString();
                            const sourceString = this.readFString();
                            value = {
                                flags,
                                historyType,
                                namespace,
                                key,
                                sourceString
                            };
                            if (this.enableDebug) {
                                this.log(`  -> FText: HistoryType=0 (Base), Namespace="${namespace}", Key="${key}", Source="${sourceString}"`);
                            }
                        } else {
                            try {
                                const namespace = this.readFString();
                                const key = this.readFString();
                                const sourceString = this.readFString();
                                value = {
                                    flags,
                                    historyType,
                                    namespace,
                                    key,
                                    sourceString
                                };
                                if (this.enableDebug) {
                                    this.log(`  -> FText: HistoryType=${historyType} (Unknown), attempting Base format. Namespace="${namespace}", Key="${key}", Source="${sourceString}"`);
                                }
                            } catch (e) {
                                debugWarn(`[Reader] FText HistoryType ${historyType} not fully supported, using fallback. Error: ${e}`);
                                value = {
                                    flags,
                                    historyType,
                                    namespace: "",
                                    key: "",
                                    sourceString: ""
                                };
                            }
                        }
                        break;
                    case "ByteProperty":
                    case "EnumProperty":
                        if (size === 8)
                            value = this.readFName(this.nameMap);
                        else {
                            value = this.readUInt8();
                        }
                        break;
                    case "DelegateProperty":
                        rawIndex = this.readInt32();
                        const delegateFunctionName = this.readFName(this.nameMap);
                        value = {
                            object: this.getObjectName(rawIndex),
                            functionName: delegateFunctionName,
                            rawIndex: rawIndex
                        };
                        break;
                    case "MulticastDelegateProperty":
                        const mcCount = this.readInt32();
                        const mcElements = [];
                        for (let i = 0; i < mcCount; i++) {
                            const obj = this.readInt32();
                            const func = this.readFName(this.nameMap);
                            mcElements.push({
                                object: this.getObjectName(obj),
                                functionName: func,
                                rawIndex: obj
                            });
                        }
                        value = mcElements;
                        isExpandable = true;
                        break;
                    case "StructProperty":
                        const structStartOffset = this.getOffset();
                        value = this.readStruct(structName || "Unknown", size);
                        if (Array.isArray(value) || typeof value === "object")
                            isExpandable = true;
                        // Capture original bytes for raw preservation mode
                        const structEndOffset = this.getOffset();
                        this.setOffset(structStartOffset);
                        const structOriginalBytes = this.readBytes(size);
                        this.setOffset(structEndOffset);
                        // Store originalBytes on the value (if it's an array of properties)
                        if (Array.isArray(value)) {
                            value._rawBytes = structOriginalBytes;
                        } else if (typeof value === "object" && value !== null) {
                            value._rawBytes = structOriginalBytes;
                        }
                        break;
                    case "ArrayProperty":
                        const arrayStartOffset = startOffset;
                        const elementCount = this.readInt32();
                        if (this.enableDebug)
                            this.log(`  -> Array Length: ${elementCount}`);
                        if (innerType === "StructProperty") {
                            // Save the header start position - we may need to rewind
                            const headerReadStart = this.getOffset();
                            let arrName, arrPropName, arrStructSize, arrStructName, guid, hasGuid;
                            let originalHeaderSize = 0; // Track original header size for total-size format arrays
                            let isTotalSizeFormat = false; // header.Size 是「全部元素总长」而非单元素长
                            let usingFallbackPath = false;
                            let fallbackLevel = 0; // 0=standard, 1=skip Name/Type, 2=minimal (StructName+GUID only)

                            // Calculate available bytes for validation
                            const totalArrayBytes = size - (headerReadStart - arrayStartOffset);

                            // ================================================================================
                            // PHYSICS COLLISION SHAPE ARRAYS - Special Handling
                            // ================================================================================
                            // Physics shape arrays (BoxElems, SphylElems, etc.) in KAggregateGeom use 
                            // native serialization without the standard struct array header format.
                            // They serialize directly: [ElementCount (already read)] + [Elements...]
                            // Each element is a tagged property list (like a mini-export).
                            const physicsArrayMap = {
                                "BoxElems": "KBoxElem",
                                "SphylElems": "KSphylElem",
                                "SphereElems": "KSphereElem",
                                "TaperedCapsuleElems": "KTaperedCapsuleElem",
                                "ConvexElems": "KConvexElem"
                            };

                            // ================================================================================
                            // MATERIAL PARAMETER ARRAYS - Use standard header parsing
                            // ================================================================================
                            // Material parameter arrays (ScalarParameterValues, VectorParameterValues, 
                            // TextureParameterValues) DO have standard struct array headers.
                            // Each element uses TAGGED PROPERTY format (ParameterName, ParameterValue, 
                            // ExpressionGUID properties terminated by "None").
                            // The header parsing will be handled below in the standard path.
                            // ================================================================================
                            const materialParameterArrayNames = [
                                "ScalarParameterValues", "VectorParameterValues", "TextureParameterValues"
                            ];
                            const isMaterialParameterArray = materialParameterArrayNames.includes(name);

                            if (physicsArrayMap.hasOwnProperty(name)) {
                                arrStructName = physicsArrayMap[name];
                                arrStructSize = 0; // Will be calculated from remaining bytes
                                arrName = name;
                                arrPropName = "StructProperty";
                                guid = "00000000-0000-0000-0000-000000000000";
                                hasGuid = 0;
                                usingFallbackPath = true;
                                fallbackLevel = 3; // Special physics array path

                                // Calculate element size from total remaining bytes
                                // Elements start immediately after array length (already read)
                                const remainingBytes = size - 4; // 4 bytes for element count
                                arrStructSize = elementCount > 0 ? Math.floor(remainingBytes / elementCount) : 0;

                                // CRITICAL: Save start offset for raw bytes preservation
                                // Physics arrays use native serialization, so we preserve the raw bytes
                                // for writing back unchanged (prevents size mismatch issues)
                                const physicsArrayDataStart = this.getOffset();

                                // Create arrayStructInfo with native physics flag
                                arrayStructInfo = {
                                    propertyName: arrName,
                                    propertyType: arrPropName,
                                    size: arrStructSize,
                                    structName: arrStructName,
                                    guid,
                                    hasGuid,
                                    isNativePhysicsArray: true, // Flag for writer to use raw bytes
                                    rawDataStart: physicsArrayDataStart,
                                    rawDataSize: remainingBytes
                                };

                                if (this.enableDebug) {
                                    console.log(`[Reader] ${name}: Detected as physics shape array. Using ${arrStructName} struct type. Element size: ${arrStructSize} bytes, Total remaining: ${remainingBytes} bytes. Raw preservation enabled.`);
                                }
                            } else if (isMaterialParameterArray) {
                                // ===================================================================================
                                // MATERIAL PARAMETER ARRAYS - Fixed Size Elements (NO None terminator!)
                                // ===================================================================================
                                // MaterialInstance arrays (ScalarParameterValues, TextureParameterValues, etc.)
                                // have a standard struct array header BUT:
                                // 1. The "Size" field contains TOTAL data size for all elements, not per-element
                                // 2. Each element is FIXED SIZE with NO "None" terminator
                                // 3. Element structure:
                                //    - ParameterName (NameProperty, 8 bytes name value)
                                //    - ParameterValue (FloatProperty/ObjectProperty, 4 bytes value)
                                //    - ExpressionGUID (StructProperty/Guid, 16 bytes GUID)
                                // ===================================================================================

                                try {
                                    // Read standard struct array header
                                    arrName = this.readFName(this.nameMap);          // Inner array name (same as outer)
                                    arrPropName = this.readFName(this.nameMap);      // "StructProperty"
                                    const totalDataSize = this.readInt32();          // TOTAL data size (not per-element!)
                                    const arrArrayIndex = this.readInt32();          // Array index (usually 0)
                                    arrStructName = this.readFName(this.nameMap);    // e.g. "ScalarParameterValue"
                                    guid = this.readGuid();                          // Struct GUID
                                    hasGuid = this.readUInt8();                      // Has GUID flag

                                    // Calculate per-element size from total data size
                                    arrStructSize = elementCount > 0 ? Math.floor(totalDataSize / elementCount) : totalDataSize;

                                    usingFallbackPath = false;
                                    fallbackLevel = 0;

                                    if (this.enableDebug) {
                                        console.log(`[Reader] ${name}: Material Parameter array.`);
                                        console.log(`[Reader]   Header: Name='${arrName}', Type='${arrPropName}', TotalSize=${totalDataSize}, StructName='${arrStructName}'`);
                                        console.log(`[Reader]   Per-element size: ${totalDataSize} / ${elementCount} = ${arrStructSize} bytes`);
                                    }

                                    // Create arrayStructInfo
                                    arrayStructInfo = {
                                        propertyName: arrName,
                                        propertyType: arrPropName,
                                        size: arrStructSize,
                                        structName: arrStructName,
                                        guid,
                                        hasGuid,
                                        isMaterialParameterArray: true,
                                        totalDataSize: totalDataSize
                                    };

                                } catch (e) {
                                    // Fallback: Skip header and calculate size
                                    if (this.enableDebug) {
                                        console.warn(`[Reader] ${name}: Material Parameter header read failed: ${e.message}. Using fallback.`);
                                    }
                                    this.setOffset(headerReadStart);

                                    const remainingBytes = size - 4; // 4 for element count already read
                                    arrStructSize = elementCount > 0 ? Math.floor(remainingBytes / elementCount) : 0;
                                    arrStructName = name.replace("Values", "数值"); // ScalarParameterValues -> ScalarParameterValue
                                    arrName = name;
                                    arrPropName = "StructProperty";
                                    guid = "00000000-0000-0000-0000-000000000000";
                                    hasGuid = 0;
                                    usingFallbackPath = true;
                                    fallbackLevel = 4;

                                    arrayStructInfo = {
                                        propertyName: arrName,
                                        propertyType: arrPropName,
                                        size: arrStructSize,
                                        structName: arrStructName,
                                        guid,
                                        hasGuid,
                                        isMaterialParameterArray: true
                                    };
                                }

                                // Now parse elements as FIXED SIZE structs (no None terminator!)
                                const materialArr = [];
                                const elementsDataStart = this.getOffset();

                                for (let i = 0; i < elementCount; i++) {
                                    const elementStart = this.getOffset();
                                    const elementEnd = elementStart + arrStructSize;

                                    if (this.enableDebug) {
                                        debugLog(`[MATERIAL PARAM] Element ${i}/${elementCount} @ ${this.formatHex(elementStart)}, size: ${arrStructSize}`);
                                    }

                                    try {
                                        const elementProps = [];

                                        // Read properties until we've consumed arrStructSize bytes
                                        // or hit end of element
                                        while (this.getOffset() < elementEnd - 8) { // -8 to ensure we can read at least a name
                                            const propStart = this.getOffset();
                                            const propName = this.readFName(this.nameMap);

                                            if (propName === "None") {
                                                // Found None - move to next property position
                                                // But don't break - continue reading
                                                continue;
                                            }

                                            if (propName.startsWith("Unknown_")) {
                                                // Invalid name - we've probably read past the element
                                                this.setOffset(propStart);
                                                break;
                                            }

                                            const propType = this.readFName(this.nameMap);
                                            const propSize = this.readInt32();
                                            const propArrIdx = this.readInt32();

                                            // Validate property looks reasonable
                                            if (propSize < 0 || propSize > 1000) {
                                                this.setOffset(propStart);
                                                break;
                                            }

                                            let propValue = null;
                                            let propRawIndex = undefined; // For ObjectProperty rawIndex
                                            let propStructName = undefined; // For StructProperty struct name (e.g., Guid)
                                            let propStructGuid = undefined; // For StructProperty struct GUID
                                            let propStructHasGuid = undefined; // For StructProperty hasGuid flag

                                            if (propType === "NameProperty") {
                                                const hasGuid = this.readUInt8();
                                                propValue = this.readFName(this.nameMap);
                                            } else if (propType === "FloatProperty") {
                                                const hasGuid = this.readUInt8();
                                                propValue = this.readFloat();
                                            } else if (propType === "ObjectProperty") {
                                                const hasGuid = this.readUInt8();
                                                const rawIdx = this.readInt32();
                                                propRawIndex = rawIdx; // Store raw index for UI display
                                                propValue = this.getObjectName(rawIdx);
                                            } else if (propType === "StructProperty") {
                                                const innerStructName = this.readFName(this.nameMap);
                                                const innerGuid = this.readGuid();
                                                const innerHasGuid = this.readUInt8();
                                                // Check if this is a LinearColor struct (used in VectorParameterValue)
                                                if (innerStructName === "LinearColor" && propSize === 16) {
                                                    // Parse LinearColor as 4 floats (R, G, B, A)
                                                    const r = this.readFloat();
                                                    const g = this.readFloat();
                                                    const b = this.readFloat();
                                                    const a = this.readFloat();
                                                    propValue = { r, g, b, a };
                                                    if (this.enableDebug) {
                                                        debugLog(`[MATERIAL PARAM]   LinearColor: R=${r}, G=${g}, B=${b}, A=${a}`);
                                                    }
                                                } else {
                                                    // Read struct value as raw bytes (typically 16 bytes for Guid)
                                                    propValue = this.readBytes(propSize);
                                                }
                                                // Store struct metadata for proper writing
                                                propStructName = innerStructName;
                                                propStructGuid = innerGuid;
                                                propStructHasGuid = innerHasGuid;
                                            } else {
                                                // Unknown type - read as bytes
                                                const hasGuid = this.readUInt8();
                                                propValue = this.readBytes(propSize);
                                            }

                                            const propEntry = {
                                                name: propName,
                                                type: propType,
                                                size: propSize,
                                                arrayIndex: propArrIdx,
                                                value: propValue
                                            };
                                            // Add rawIndex for ObjectProperty (needed for Variant column in UI)
                                            if (propRawIndex !== undefined) {
                                                propEntry.rawIndex = propRawIndex;
                                            }
                                            // Add struct metadata for StructProperty (e.g., ExpressionGUID with Guid struct)
                                            // Field names match what writer expects: structName, structHeaderGuid
                                            if (propStructName !== undefined) {
                                                propEntry.structName = propStructName;
                                                propEntry.structHeaderGuid = propStructGuid; // Writer expects structHeaderGuid
                                                propEntry.hasPropertyGuid = propStructHasGuid;
                                            }
                                            elementProps.push(propEntry);

                                            if (this.enableDebug) {
                                                debugLog(`[MATERIAL PARAM]   ${propName}: ${propType} = ${typeof propValue === 'object' ? '[data]' : propValue}`);
                                            }
                                        }

                                        // Ensure we're at the exact end of the element
                                        if (this.getOffset() !== elementEnd) {
                                            this.setOffset(elementEnd);
                                        }

                                        materialArr.push(elementProps);

                                    } catch (e) {
                                        if (this.enableDebug) {
                                            debugError(`[MATERIAL PARAM] Error parsing element ${i}: ${e.message}`);
                                        }
                                        // Fallback: read as raw bytes
                                        this.setOffset(elementStart);
                                        const rawBytes = this.readBytes(arrStructSize);
                                        materialArr.push([{
                                            name: "RawData",
                                            type: "ByteProperty",
                                            size: arrStructSize,
                                            arrayIndex: 0,
                                            value: rawBytes
                                        }]);
                                    }
                                }

                                value = materialArr;
                                isExpandable = true;

                                // Skip to end of array data and continue with normal flow
                                // We've already parsed elements, so jump past the standard parsing below

                            } else {

                                try {
                                    // Attempt 1: Standard header format 
                                    // Format: Name(8) + Type(8) + Size(4) + ArrayIndex(4) + StructName(8) + GUID(16) + hasGuid(1) = 49 bytes
                                    arrName = this.readFName(this.nameMap);
                                    arrPropName = this.readFName(this.nameMap);
                                    arrStructSize = this.readInt32();
                                    originalHeaderSize = arrStructSize; // PRESERVE: Original header size value for writing
                                    const arrArrayIndex = this.readInt32(); // ArrayIndex field - was missing!
                                    arrStructName = this.readFName(this.nameMap);
                                    guid = this.readGuid();
                                    hasGuid = this.readUInt8();

                                    // Validate the header immediately
                                    const headerBytesUsed = this.getOffset() - arrayStartOffset;
                                    const remainingArrayBytes = size - headerBytesUsed;
                                    const calculatedElementSize = elementCount > 0 ? Math.floor(remainingArrayBytes / elementCount) : 0;

                                    // CRITICAL FIX: For MaterialInstance struct arrays, the Size field in the 
                                    // struct array header contains the TOTAL data size (all elements combined),
                                    // NOT the per-element size. We need to detect this and adjust.
                                    // If arrStructSize is close to remainingArrayBytes, it's likely the total size.
                                    // If arrStructSize * elementCount > remainingArrayBytes, then arrStructSize is total size.
                                    let actualElementSize = arrStructSize;
                                    let statedTotalSize;

                                    // Check if arrStructSize looks like total size rather than element size
                                    const looksLikeTotalSize = arrStructSize > 0 && (
                                        // If arrStructSize is close to remainingArrayBytes (within 10%), it's total size
                                        (Math.abs(arrStructSize - remainingArrayBytes) < remainingArrayBytes * 0.1) ||
                                        // If arrStructSize * elementCount > remainingArrayBytes, arrStructSize must be total
                                        (arrStructSize * elementCount > remainingArrayBytes + 100)
                                    );

                                    if (looksLikeTotalSize && elementCount > 1) {
                                        // arrStructSize is the total size, not element size
                                        actualElementSize = Math.floor(arrStructSize / elementCount);
                                        statedTotalSize = arrStructSize;
                                        if (this.enableDebug) {
                                            console.log(`[Reader] Detected total-size format: ${arrStructSize} / ${elementCount} = ${actualElementSize} bytes per element`);
                                        }
                                    } else {
                                        statedTotalSize = arrStructSize * elementCount;
                                    }

                                    // Detect anomalies: file path in struct name, wrong property type, or invalid size
                                    // Note: Struct names containing "/" might be file paths, but we'll try to extract a valid name
                                    let extractedStructName = arrStructName;
                                    if (arrStructName.includes("/")) {
                                        // Try to extract struct name from file path (take last part after /)
                                        const parts = arrStructName.split("/");
                                        if (parts.length > 0) {
                                            extractedStructName = parts[parts.length - 1];
                                            // Remove file extension if present
                                            if (extractedStructName.includes(".")) {
                                                extractedStructName = extractedStructName.split(".")[0];
                                            }
                                            if (this.enableDebug) {
                                                console.log(`[Reader] Extracted struct name '${extractedStructName}' from path '${arrStructName}'`);
                                            }
                                        }
                                    }

                                    const isStructNameInvalid = arrStructName.startsWith("Unknown_") ||
                                        (arrStructName.includes("/") && extractedStructName === arrStructName) ||
                                        arrStructName.length > 200; // Unreal struct names are typically short
                                    const isPropTypeWrong = arrPropName !== "StructProperty" && arrPropName !== "None";
                                    // Use actualElementSize for size validation (accounts for total-size format)
                                    const isSizeTooLarge = actualElementSize > 0 && (statedTotalSize > remainingArrayBytes + 100 ||
                                        (calculatedElementSize > 0 && actualElementSize > calculatedElementSize * 2));

                                    // Update arrStructSize to actualElementSize if we detected total-size format
                                    if (looksLikeTotalSize && elementCount > 1) {
                                        arrStructSize = actualElementSize;
                                        isTotalSizeFormat = true;
                                    }

                                    // If we extracted a valid struct name from a path, use it
                                    if (arrStructName.includes("/") && extractedStructName !== arrStructName && extractedStructName.length > 0 && extractedStructName.length <= 200) {
                                        arrStructName = extractedStructName;
                                        if (this.enableDebug) {
                                            console.log(`[Reader] Using extracted struct name: '${arrStructName}'`);
                                        }
                                    }

                                    if (isStructNameInvalid || isPropTypeWrong || isSizeTooLarge) {
                                        if (this.enableDebug) {
                                            console.warn(`[Reader] Anomaly detected for '${name}': StructName='${arrStructName}', PropType='${arrPropName}', StatedSize=${arrStructSize}, CalculatedSize=${calculatedElementSize}. Rewinding to try simplified header.`);
                                        }

                                        // REWIND: Go back to header start
                                        this.setOffset(headerReadStart);
                                        usingFallbackPath = true;
                                        fallbackLevel = 1;

                                        // Attempt 2: Simplified header (skip Name and Type): Size -> StructName -> GUID -> hasGuid
                                        try {
                                            arrStructSize = this.readInt32();
                                            arrStructName = this.readFName(this.nameMap);
                                            guid = this.readGuid();
                                            hasGuid = this.readUInt8();

                                            // Validate again
                                            const headerBytesUsed2 = this.getOffset() - arrayStartOffset;
                                            const remainingArrayBytes2 = size - headerBytesUsed2;
                                            const calculatedElementSize2 = elementCount > 0 ? Math.floor(remainingArrayBytes2 / elementCount) : 0;
                                            const statedTotalSize2 = arrStructSize * elementCount;
                                            const isStructNameStillInvalid = arrStructName.startsWith("Unknown_") || arrStructName.includes("/") ||
                                                arrStructName.length > 200;
                                            const isSizeStillTooLarge = arrStructSize > 0 && (statedTotalSize2 > remainingArrayBytes2 + 100 ||
                                                (calculatedElementSize2 > 0 && arrStructSize > calculatedElementSize2 * 2));

                                            if (isStructNameStillInvalid || isSizeStillTooLarge) {
                                                if (this.enableDebug) {
                                                    console.warn(`[Reader] Simplified header still invalid. Trying minimal header (StructName+GUID only) or hardcoded for '${name}'.`);
                                                }

                                                // REWIND again
                                                this.setOffset(headerReadStart);
                                                fallbackLevel = 2;

                                                // Attempt 3: Minimal header (StructName -> GUID only, no Size)
                                                // Or use hardcoded struct name for known properties
                                                if (name === "ConfigAttrModifyList") {
                                                    // Hardcode the expected struct name for this specific property
                                                    arrStructName = "AttrModifyItem";
                                                    arrStructSize = 0; // Will be calculated
                                                    arrName = "";
                                                    arrPropName = "StructProperty";

                                                    // Try to read GUID (might be present)
                                                    try {
                                                        const guidTestOffset = this.getOffset();
                                                        guid = this.readGuid();
                                                        hasGuid = this.readUInt8();
                                                        if (this.enableDebug) {
                                                            console.log(`[Reader] Minimal header: Read GUID from offset ${guidTestOffset}`);
                                                        }
                                                    } catch (guidErr) {
                                                        // GUID might not be present either - ensure we're still at header start
                                                        this.setOffset(headerReadStart);
                                                        if (this.enableDebug) {
                                                            console.warn(`[Reader] GUID not found, using default. Offset reset to header start: ${guidErr.message}`);
                                                        }
                                                        guid = "00000000-0000-0000-0000-000000000000";
                                                        hasGuid = 0;
                                                    }
                                                } else if (name === "IconList") {
                                                    // IconList has a special format: no struct name in header, elements are directly property lists
                                                    // Skip header entirely and use calculated size
                                                    arrStructName = "IconListElement"; // Use a generic name for the struct
                                                    arrStructSize = 0; // Will be calculated
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                    // Don't read anything from header - elements start immediately
                                                    if (this.enableDebug) {
                                                        console.log(`[Reader] IconList: Using no-header format, elements start at offset ${this.formatHex(headerReadStart)}`);
                                                    }
                                                } else if (name === "BoxElems") {
                                                    // KAggregateGeom.BoxElems - Array of KBoxElem
                                                    arrStructName = "KBoxElem";
                                                    arrStructSize = 0; // Will be calculated
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                    if (this.enableDebug) {
                                                        console.log(`[Reader] BoxElems: Using KBoxElem struct type`);
                                                    }
                                                } else if (name === "SphylElems") {
                                                    // KAggregateGeom.SphylElems - Array of KSphylElem (Capsule)
                                                    arrStructName = "KSphylElem";
                                                    arrStructSize = 0; // Will be calculated
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                    if (this.enableDebug) {
                                                        console.log(`[Reader] SphylElems: Using KSphylElem struct type`);
                                                    }
                                                } else if (name === "SphereElems") {
                                                    // KAggregateGeom.SphereElems - Array of KSphereElem
                                                    arrStructName = "KSphereElem";
                                                    arrStructSize = 0; // Will be calculated
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                    if (this.enableDebug) {
                                                        console.log(`[Reader] SphereElems: Using KSphereElem struct type`);
                                                    }
                                                } else if (name === "TaperedCapsuleElems") {
                                                    // KAggregateGeom.TaperedCapsuleElems - Array of KTaperedCapsuleElem
                                                    arrStructName = "KTaperedCapsuleElem";
                                                    arrStructSize = 0; // Will be calculated
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                    if (this.enableDebug) {
                                                        console.log(`[Reader] TaperedCapsuleElems: Using KTaperedCapsuleElem struct type`);
                                                    }
                                                } else if (name === "ConvexElems") {
                                                    // KAggregateGeom.ConvexElems - Array of KConvexElem
                                                    arrStructName = "KConvexElem";
                                                    arrStructSize = 0; // Will be calculated
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                    if (this.enableDebug) {
                                                        console.log(`[Reader] ConvexElems: Using KConvexElem struct type`);
                                                    }
                                                } else {
                                                    // For other properties, try reading just StructName
                                                    try {
                                                        arrStructName = this.readFName(this.nameMap);
                                                        arrStructSize = 0; // Will be calculated
                                                        arrName = "";
                                                        arrPropName = "StructProperty";

                                                        // If struct name contains "/" (file path), try to extract valid name
                                                        if (arrStructName.includes("/")) {
                                                            const parts = arrStructName.split("/");
                                                            if (parts.length > 0) {
                                                                let extracted = parts[parts.length - 1];
                                                                // Remove file extension if present
                                                                if (extracted.includes(".")) {
                                                                    extracted = extracted.split(".")[0];
                                                                }
                                                                if (extracted.length > 0 && extracted.length <= 200 && !extracted.startsWith("Unknown_")) {
                                                                    if (this.enableDebug) {
                                                                        console.log(`[Reader] Extracted struct name '${extracted}' from path '${arrStructName}' in minimal header`);
                                                                    }
                                                                    arrStructName = extracted;
                                                                }
                                                            }
                                                        }

                                                        // Try GUID
                                                        try {
                                                            guid = this.readGuid();
                                                            hasGuid = this.readUInt8();
                                                        } catch {
                                                            // Ensure offset is correct if GUID read failed
                                                            const currentOffset = this.getOffset();
                                                            // If we read the struct name (8 bytes), we're at headerReadStart + 8
                                                            // If GUID read failed, stay there (no rewind needed as struct name was valid)
                                                            guid = "00000000-0000-0000-0000-000000000000";
                                                            hasGuid = 0;
                                                        }
                                                    } catch (minimalErr) {
                                                        // Last resort: use calculated size and guess struct name
                                                        if (this.enableDebug) {
                                                            console.warn(`[Reader] Minimal header read failed: ${minimalErr.message}. Using calculated size only.`);
                                                        }
                                                        arrStructName = "UnknownStruct";
                                                        arrStructSize = 0;
                                                        arrName = "";
                                                        arrPropName = "StructProperty";
                                                        guid = "00000000-0000-0000-0000-000000000000";
                                                        hasGuid = 0;
                                                    }
                                                }
                                            } else {
                                                // Simplified header worked
                                                arrName = "";
                                                arrPropName = "StructProperty";
                                                if (this.enableDebug) {
                                                    console.log(`[Reader] Simplified header successful. StructName: '${arrStructName}', Size: ${arrStructSize}`);
                                                }
                                            }
                                        } catch (simplifiedErr) {
                                            // Simplified header read failed, try minimal
                                            if (this.enableDebug) {
                                                console.warn(`[Reader] Simplified header read failed: ${simplifiedErr.message}. Trying minimal header.`);
                                            }
                                            this.setOffset(headerReadStart);
                                            fallbackLevel = 2;

                                            if (name === "ConfigAttrModifyList") {
                                                arrStructName = "AttrModifyItem";
                                                arrStructSize = 0;
                                                arrName = "";
                                                arrPropName = "StructProperty";
                                                // Try to read GUID, but if it fails, ensure we're at header start
                                                try {
                                                    guid = this.readGuid();
                                                    hasGuid = this.readUInt8();
                                                } catch {
                                                    this.setOffset(headerReadStart);
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                }
                                            } else {
                                                // Try to read at least the struct name
                                                try {
                                                    arrStructName = this.readFName(this.nameMap);
                                                    arrStructSize = 0;
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    // Try GUID
                                                    try {
                                                        guid = this.readGuid();
                                                        hasGuid = this.readUInt8();
                                                    } catch {
                                                        guid = "00000000-0000-0000-0000-000000000000";
                                                        hasGuid = 0;
                                                    }
                                                } catch {
                                                    // If struct name read failed, ensure we're at header start
                                                    this.setOffset(headerReadStart);
                                                    arrStructName = "UnknownStruct";
                                                    arrStructSize = 0;
                                                    arrName = "";
                                                    arrPropName = "StructProperty";
                                                    guid = "00000000-0000-0000-0000-000000000000";
                                                    hasGuid = 0;
                                                }
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // Standard header read completely failed
                                    if (this.enableDebug) {
                                        console.warn(`[Reader] Standard header read failed for '${name}', trying fallback paths: ${e.message}`);
                                    }
                                    this.setOffset(headerReadStart);
                                    usingFallbackPath = true;
                                    fallbackLevel = 1;

                                    try {
                                        // Try simplified header
                                        arrStructSize = this.readInt32();
                                        arrStructName = this.readFName(this.nameMap);
                                        guid = this.readGuid();
                                        hasGuid = this.readUInt8();
                                        arrName = "";
                                        arrPropName = "StructProperty";

                                        // Validate
                                        const headerBytesUsed3 = this.getOffset() - arrayStartOffset;
                                        const remainingArrayBytes3 = size - headerBytesUsed3;
                                        const calculatedElementSize3 = elementCount > 0 ? Math.floor(remainingArrayBytes3 / elementCount) : 0;
                                        const isStructNameInvalid3 = arrStructName.startsWith("Unknown_") || arrStructName.includes("/");

                                        if (isStructNameInvalid3) {
                                            // Still invalid, use hardcoded or minimal
                                            this.setOffset(headerReadStart);
                                            fallbackLevel = 2;
                                            if (name === "ConfigAttrModifyList") {
                                                arrStructName = "AttrModifyItem";
                                                arrStructSize = 0;
                                            } else if (name === "IconList") {
                                                arrStructName = "IconListElement";
                                                arrStructSize = 0;
                                            } else {
                                                arrStructName = "UnknownStruct";
                                                arrStructSize = 0;
                                            }
                                            arrName = "";
                                            arrPropName = "StructProperty";
                                            guid = "00000000-0000-0000-0000-000000000000";
                                            hasGuid = 0;
                                        }
                                    } catch (fallbackErr) {
                                        // All header reads failed, use minimal/hardcoded
                                        if (this.enableDebug) {
                                            console.warn(`[Reader] All header read attempts failed for '${name}'. Using hardcoded/minimal values.`);
                                        }
                                        this.setOffset(headerReadStart);
                                        fallbackLevel = 2;

                                        // Ensure offset is at header start for hardcoded values
                                        this.setOffset(headerReadStart);
                                        // Ensure offset is at header start for hardcoded values
                                        this.setOffset(headerReadStart);
                                        if (name === "ConfigAttrModifyList") {
                                            arrStructName = "AttrModifyItem";
                                            arrStructSize = 0;
                                        } else if (name === "IconList") {
                                            arrStructName = "IconListElement";
                                            arrStructSize = 0;
                                        } else {
                                            arrStructName = "UnknownStruct";
                                            arrStructSize = 0;
                                        }
                                        arrName = "";
                                        arrPropName = "StructProperty";
                                        guid = "00000000-0000-0000-0000-000000000000";
                                        hasGuid = 0;
                                    }
                                }
                            } // End of else block for non-physics arrays

                            // Calculate final header bytes used and remaining array bytes
                            // For IconList, header might be empty or malformed, so use the full size
                            let finalHeaderOffset = this.getOffset();
                            if (name === "IconList" && fallbackLevel === 2) {
                                // IconList has no header, elements start immediately after array length
                                finalHeaderOffset = headerReadStart;
                                if (this.enableDebug) {
                                    console.log(`[Reader] IconList: No header, elements start at ${this.formatHex(finalHeaderOffset)}`);
                                }
                            }
                            const headerBytesUsed = finalHeaderOffset - arrayStartOffset;
                            const remainingArrayBytes = size - headerBytesUsed;
                            const calculatedElementSize = elementCount > 0 ? Math.floor(remainingArrayBytes / elementCount) : 0;
                            const remainder = elementCount > 0 ? remainingArrayBytes % elementCount : 0;

                            // If size wasn't read or is invalid, use calculated size
                            if (arrStructSize <= 0 || (arrStructSize * elementCount > remainingArrayBytes + 100)) {
                                arrStructSize = calculatedElementSize;
                                if (this.enableDebug && fallbackLevel >= 1) {
                                    console.log(`[Reader] Using calculated element size: ${calculatedElementSize} bytes (was ${arrStructSize})`);
                                }
                            }

                            const pathNames = ["[STANDARD]", "[SIMPLIFIED]", "[MINIMAL/HARDCODED]", "[PHYSICS NATIVE]"];
                            if (this.enableDebug) {
                                this.log(`  -> Array Inner Struct: ${arrStructName} (Size: ${arrStructSize}) ${pathNames[fallbackLevel] || ""}`);
                            }

                            // Only create arrayStructInfo if not already created (physics arrays create it early)
                            if (!arrayStructInfo) {
                                // Use originalHeaderSize for struct array header if available (for total-size format arrays)
                                // If arrStructSize was modified from total to per-element, originalHeaderSize has the original
                                const headerSizeToWrite = originalHeaderSize > 0 ? originalHeaderSize : arrStructSize;
                                arrayStructInfo = {
                                    propertyName: arrName,
                                    propertyType: arrPropName,
                                    size: arrStructSize,
                                    originalHeaderSize: headerSizeToWrite, // Original header value for writing
                                    structName: arrStructName,
                                    guid,
                                    hasGuid
                                };
                            }
                            // Calculate statedTotalSize for other validations
                            // Note: Material Parameter arrays are now handled above in their own block
                            const statedTotalSize = arrStructSize * elementCount;
                            const hasStructSizeMismatch = arrStructSize > 0 && (
                                statedTotalSize > remainingArrayBytes ||
                                (calculatedElementSize > 0 && Math.abs(arrStructSize - calculatedElementSize) > 4)
                            );
                            if (hasStructSizeMismatch) {
                                if (this.enableDebug) {
                                    console.warn(`[Reader] Struct Size Mismatch for '${name}'. Stated: ${arrStructSize} * ${elementCount} = ${statedTotalSize} > Available: ${remainingArrayBytes}. Using calculated size: ${calculatedElementSize} bytes per element.`);
                                }
                                // Update arrayStructInfo with calculated size so it's written correctly
                                if (arrayStructInfo) {
                                    arrayStructInfo.size = calculatedElementSize;
                                    if (this.enableDebug) {
                                        this.log(`  -> Updated arrayStructInfo.size from ${arrStructSize} to ${calculatedElementSize}`);
                                    }
                                }
                                const arr = [];
                                // Try to parse as structs if possible, otherwise read as raw bytes
                                const materialParameterStructs = ["VectorParameterValue", "ScalarParameterValue", "TextureParameterValue"];
                                const shouldParseAsStruct = materialParameterStructs.includes(arrStructName);
                                for (let i = 0; i < elementCount; i++) {
                                    const elementStartOffset = this.getOffset();
                                    let elementSizeToRead = calculatedElementSize;
                                    // Add remainder to last element
                                    if (i === elementCount - 1 && remainder > 0) {
                                        elementSizeToRead += remainder;
                                    }
                                    try {
                                        if (shouldParseAsStruct && elementSizeToRead > 0) {
                                            // Try to parse as struct
                                            const structValue = this.readStruct(arrStructName, elementSizeToRead);
                                            if (Array.isArray(structValue)) {
                                                arr.push(structValue);
                                            } else {
                                                // Fallback to raw bytes
                                                this.setOffset(elementStartOffset);
                                                const rawChunk = this.readBytes(elementSizeToRead);
                                                arr.push(rawChunk);
                                            }
                                        } else {
                                            // Read as raw bytes
                                            const rawChunk = this.readBytes(elementSizeToRead);
                                            arr.push(rawChunk);
                                        }
                                    } catch (e) {
                                        // Fallback: read as raw bytes
                                        if (this.enableDebug) {
                                            console.warn(`[Reader] Error reading element ${i + 1}/${elementCount}, using raw bytes: ${e.message}`);
                                        }
                                        this.setOffset(elementStartOffset);
                                        const rawChunk = this.readBytes(elementSizeToRead);
                                        arr.push(rawChunk);
                                    }
                                    // Ensure we're at the correct position
                                    const expectedEnd = elementStartOffset + elementSizeToRead;
                                    if (this.getOffset() !== expectedEnd) {
                                        this.setOffset(expectedEnd);
                                    }
                                }
                                value = arr;
                                isExpandable = true;
                            } else {
                                // Normal path: use stated size, but validate and fallback to calculated if needed
                                let actualElementSize = arrStructSize;
                                const statedTotalSize = arrStructSize * elementCount;
                                // Check for mismatch: stated size * count exceeds available, or calculated differs significantly
                                if (arrStructSize > 0 && (statedTotalSize > remainingArrayBytes ||
                                    (calculatedElementSize > 0 && Math.abs(arrStructSize - calculatedElementSize) > 4))) {
                                    if (this.enableDebug) {
                                        console.warn(`[Reader] Struct Size Mismatch for '${name}'. Stated: ${arrStructSize} * ${elementCount} = ${statedTotalSize} > Available: ${remainingArrayBytes}. Using calculated size: ${calculatedElementSize} bytes per element.`);
                                    }
                                    actualElementSize = calculatedElementSize;
                                    // Update arrayStructInfo with calculated size for correct writing
                                    if (arrayStructInfo) {
                                        arrayStructInfo.size = calculatedElementSize;
                                    }
                                } else if (actualElementSize <= 0) {
                                    actualElementSize = calculatedElementSize;
                                    // Update arrayStructInfo if size was invalid
                                    if (arrayStructInfo && calculatedElementSize > 0) {
                                        arrayStructInfo.size = calculatedElementSize;
                                    }
                                } else if (isMaterialParameterArray && arrStructSize > 0 && statedTotalSize > remainingArrayBytes) {
                                    actualElementSize = calculatedElementSize;
                                    if (arrayStructInfo) {
                                        arrayStructInfo.size = calculatedElementSize;
                                    }
                                }
                                if (this.enableDebug && remainingArrayBytes !== size) {
                                    this.log(`  -> Array header used ${headerBytesUsed} bytes, ${remainingArrayBytes} bytes remaining for ${elementCount} elements`);
                                    this.log(`  -> Element size: ${actualElementSize} bytes (calculated: ${calculatedElementSize}, stated: ${arrStructSize})`);
                                    if (remainder > 0) {
                                        this.log(`  -> Remainder: ${remainder} bytes will be added to the last element`);
                                    }
                                }
                                const materialParameterStructs = ["VectorParameterValue", "ScalarParameterValue", "TextureParameterValue"];
                                const shouldParseAsStruct = materialParameterStructs.includes(arrStructName);
                                const arr = [];
                                const bufferSize = this.getBufferSize();

                                // Debug hex dump for ConfigAttrModifyList
                                if (name === "ConfigAttrModifyList") {
                                    const previewOffset = this.getOffset();
                                    const previewSize = Math.min(64, remainingArrayBytes);
                                    try {
                                        const previewBytes = this.readBytes(previewSize);
                                        if (this.enableDebug) {
                                            console.log(`[DEBUG] ConfigAttrModifyList First Element Preview (${previewSize} bytes @ ${this.formatHex(previewOffset)}):`);
                                            console.log(this.formatHexDump(previewBytes, previewOffset));
                                        }
                                        // Reset offset after preview
                                        this.setOffset(previewOffset);
                                    } catch (previewErr) {
                                        if (this.enableDebug) {
                                            console.warn(`[DEBUG] Failed to read preview for ConfigAttrModifyList: ${previewErr.message}`);
                                        }
                                        this.setOffset(previewOffset);
                                    }
                                }

                                if (shouldParseAsStruct) {
                                    if (this.enableDebug) {
                                        this.log(`  -> Parsing ${arrStructName} array elements as structs (MaterialInstanceConstant parameter)`);
                                    }
                                    for (let i = 0; i < elementCount; i++) {
                                        let sizeToRead = actualElementSize;
                                        if (i === elementCount - 1) {
                                            sizeToRead += remainder;
                                        }
                                        const currentOffset = this.getOffset();
                                        const maxReadableBytes = bufferSize - currentOffset;
                                        if (sizeToRead > maxReadableBytes) {
                                            console.warn(`[Reader] Array element ${i + 1}/${elementCount} size ${sizeToRead} exceeds remaining buffer (${maxReadableBytes} bytes). Clamping.`);
                                            sizeToRead = Math.max(0, maxReadableBytes);
                                        }
                                        try {
                                            const structStartOffset = this.getOffset();
                                            const structValue = this.readStruct(arrStructName, sizeToRead);
                                            if (Array.isArray(structValue)) {
                                                arr.push(structValue);
                                            } else {
                                                this.setOffset(structStartOffset);
                                                const rawChunk = this.readBytes(sizeToRead);
                                                arr.push(rawChunk);
                                            }
                                        } catch (e) {
                                            console.error(`[Reader] Error parsing struct element ${i + 1}/${elementCount} for '${name}': ${e}`);
                                            const structStartOffset = this.getOffset();
                                            try {
                                                const rawChunk = this.readBytes(sizeToRead);
                                                arr.push(rawChunk);
                                            } catch (readErr) {
                                                arr.push(new Uint8Array(sizeToRead));
                                                this.setOffset(structStartOffset + sizeToRead);
                                            }
                                        }
                                    }
                                } else {
                                    // Check if this is a variable-sized struct array (like AttrModifyItem)
                                    const isVariableSizedStruct = arrStructName === "AttrModifyItem" || name === "ConfigAttrModifyList";

                                    if (isVariableSizedStruct && arrStructName === "AttrModifyItem") {
                                        // AttrModifyItem uses normal tagged property format (like other structs)
                                        // Each element is a property list ending with 'None' terminator
                                        // CRITICAL: Element sizes are VARIABLE - do NOT use fixed stride!
                                        // Each element ends at its own None terminator.
                                        if (this.enableDebug) {
                                            console.log(`[Reader] Parsing AttrModifyItem array '${name}' (${elementCount} elements) using None-Terminator Mode (variable size).`);
                                        }

                                        // Calculate array boundary (absolute end offset)
                                        const arrayDataEnd = arrayStartOffset + size;

                                        for (let i = 0; i < elementCount; i++) {
                                            const elementStartOffset = this.getOffset();

                                            // Safety check: don't start past array boundary
                                            if (elementStartOffset >= arrayDataEnd) {
                                                if (this.enableDebug) {
                                                    console.warn(`[Reader] AttrModifyItem element ${i}: Already at/past array boundary at ${this.formatHex(elementStartOffset)}`);
                                                }
                                                break;
                                            }

                                            try {
                                                // Parse properties until None terminator
                                                // Use arrayDataEnd as safety limit only
                                                const structProps = this.readProperties(arrayDataEnd);

                                                if (Array.isArray(structProps) && structProps.length > 0) {
                                                    arr.push(structProps);
                                                    if (this.enableDebug && i === 0) {
                                                        const elementSize = this.getOffset() - elementStartOffset;
                                                        console.log(`[Reader] Element ${i + 1} parsed successfully with ${structProps.length} properties (${elementSize} bytes).`);
                                                    }
                                                } else {
                                                    // Empty struct - still valid, push empty array
                                                    arr.push([]);
                                                    if (this.enableDebug) {
                                                        console.log(`[Reader] Element ${i + 1} is empty.`);
                                                    }
                                                }

                                                // DO NOT force offset to any stride position!
                                                // The readProperties function already stopped at None terminator
                                                // which is the correct end of this element.

                                            } catch (fieldErr) {
                                                if (this.enableDebug) console.error(`[Reader] Error parsing AttrModifyItem element ${i}: ${fieldErr}`);

                                                // On error, we can't continue reliably
                                                // Save remaining data as raw bytes and break
                                                const remainingBytes = arrayDataEnd - this.getOffset();
                                                if (remainingBytes > 0) {
                                                    const raw = this.readBytes(remainingBytes);
                                                    arr.push([{
                                                        name: "RemainingData",
                                                        type: "ByteProperty",
                                                        size: remainingBytes,
                                                        arrayIndex: 0,
                                                        value: raw
                                                    }]);
                                                }
                                                break;
                                            }
                                        }

                                        // Ensure we're at array end after processing
                                        if (this.getOffset() < arrayDataEnd) {
                                            const skipped = arrayDataEnd - this.getOffset();
                                            if (this.enableDebug) {
                                                console.log(`[Reader] AttrModifyItem: Skipping ${skipped} trailing bytes to reach array end.`);
                                            }
                                            this.setOffset(arrayDataEnd);
                                        }
                                    } else {
                                        // Fixed-size struct array: use calculated element size
                                        // Try to parse as structs even if struct name is unknown/invalid
                                        // This handles cases where struct name contains "/" (file path) but properties can still be read
                                        const shouldTryParseAsStruct = arrStructName && arrStructName !== "UnknownStruct" && actualElementSize > 0;
                                        const shouldTryParseUnknown = arrStructName === "UnknownStruct" && actualElementSize > 8; // Try parsing if we have enough bytes for at least one property
                                        const isIconList = name === "IconList"; // Special handling for IconList

                                        // IconList: Each element is a full property list (Icon, Offset, Alpha, Rotate, etc.)
                                        // We must NOT use size calculations - readProperties will read until 'None' terminator
                                        if (isIconList) {
                                            // GHOST HEADER FIX: Check for and consume wrapper StructProperty header at the start
                                            // This header wraps all elements and has a size covering the entire array - we must ignore it
                                            const headerCheckPos = this.getOffset();
                                            try {
                                                const potentialName = this.readFName(this.nameMap);
                                                const potentialType = this.readFName(this.nameMap);

                                                if (this.enableDebug) {
                                                    this.log(`[Reader] IconList: Checking for ghost header. Name: "${potentialName}", Type: "${potentialType}"`);
                                                }

                                                if (potentialName === "IconList" && potentialType === "StructProperty") {
                                                    // Found the wrapper header! Consume it but ignore its size
                                                    const ghostSize = this.readInt32(); // Read but IGNORE this size (it covers the whole array)
                                                    const ghostIndex = this.readInt32();
                                                    const ghostStructName = this.readFName(this.nameMap);
                                                    const ghostStructHeaderGuid = this.readGuid();
                                                    const ghostHasPropertyGuid = this.readUInt8();
                                                    let ghostPropertyGuid = void 0;
                                                    if (ghostHasPropertyGuid !== 0) {
                                                        ghostPropertyGuid = this.readGuid();
                                                    }

                                                    // CRITICAL: Save the ghost header metadata to preserve struct name and GUID for writing
                                                    // Update the variables that were set earlier (they may have been set incorrectly)
                                                    arrName = potentialName;
                                                    arrPropName = potentialType;
                                                    arrStructName = ghostStructName; // e.g., "WeaponCrossHairIconData"
                                                    guid = ghostStructHeaderGuid;
                                                    hasGuid = ghostHasPropertyGuid;

                                                    // Create the info object immediately so it attaches to the property
                                                    arrayStructInfo = {
                                                        propertyName: arrName,
                                                        propertyType: arrPropName,
                                                        size: arrStructSize, // Keep the original size (will be recalculated later if needed)
                                                        structName: arrStructName,
                                                        guid: guid,
                                                        hasGuid: hasGuid
                                                    };

                                                    if (this.enableDebug) {
                                                        this.log(`[Reader] IconList: Found ghost wrapper header! Size: ${ghostSize} bytes (IGNORED), StructName: "${ghostStructName}", StructHeaderGuid: ${this.formatGuid(ghostStructHeaderGuid)}. Metadata saved to arrayStructInfo. Header consumed, cursor now at real Element 0 start.`);
                                                    }
                                                    // Header consumed. Cursor is now at the real start of Element 0 data.
                                                } else {
                                                    // Not the wrapper header, rewind to original position
                                                    this.setOffset(headerCheckPos);
                                                    if (this.enableDebug) {
                                                        this.log(`[Reader] IconList: No ghost header detected. Starting element loop from offset ${this.formatHex(headerCheckPos)}`);
                                                    }
                                                }
                                            } catch (headerCheckErr) {
                                                // If header check fails, rewind and continue normally
                                                this.setOffset(headerCheckPos);
                                                if (this.enableDebug) {
                                                    this.log(`[Reader] IconList: Ghost header check failed: ${headerCheckErr.message}. Rewinding and continuing normally.`);
                                                }
                                            }

                                            // NOW start the loop - cursor is at the real start of Element 0
                                            for (let i = 0; i < elementCount; i++) {
                                                const elementStartOffset = this.getOffset();

                                                try {
                                                    // Calculate a safe maximum limit just to prevent buffer overflow
                                                    // BUT DO NOT FORCE ALIGNMENT based on this - it's only a safety check
                                                    const currentOffset = this.getOffset();
                                                    const safeSizeLimit = bufferSize - currentOffset;

                                                    if (safeSizeLimit <= 0 || safeSizeLimit > 10 * 1024 * 1024) {
                                                        throw new Error(`Invalid safeSizeLimit for IconList element ${i + 1}: ${safeSizeLimit} bytes`);
                                                    }

                                                    // Calculate endOffset for readProperties (it reads until this offset or 'None' terminator)
                                                    const endOffset = currentOffset + safeSizeLimit;

                                                    if (this.enableDebug) {
                                                        this.log(`[Reader] IconList element ${i + 1}/${elementCount}: Reading property list from offset ${this.formatHex(currentOffset)} with safe limit ${safeSizeLimit} bytes (endOffset: ${this.formatHex(endOffset)})`);
                                                    }

                                                    // CRITICAL: Treat this element as a full Property List, not a single struct.
                                                    // readProperties will read Icon, Offset, Alpha... and consume the 'None' at the end of the list.
                                                    const elementProps = this.readProperties(endOffset);

                                                    if (Array.isArray(elementProps) && elementProps.length > 0) {
                                                        arr.push(elementProps);

                                                        const totalConsumed = this.getOffset() - elementStartOffset;

                                                        if (this.enableDebug) {
                                                            this.log(`[Reader] IconList element ${i + 1} successfully parsed. Found ${elementProps.length} properties. Total consumed: ${totalConsumed} bytes. Next element starts at ${this.formatHex(this.getOffset())} (natural position, no forced alignment)`);
                                                        }

                                                        // TRUST THE NATURAL CURSOR POSITION
                                                        // readProperties read all properties until 'None' terminator
                                                        // The cursor is now at the exact start of the next element
                                                        // Do NOT manually setOffset here - readProperties consumed the terminator correctly
                                                    } else {
                                                        throw new Error(`IconList element ${i + 1} parsed but returned empty property list`);
                                                    }
                                                } catch (iconListErr) {
                                                    if (this.enableDebug) {
                                                        console.warn(`[Reader] IconList element ${i + 1}/${elementCount} readProperties failed: ${iconListErr.message}. Current offset: ${this.formatHex(this.getOffset())}.`);
                                                    }

                                                    // Fallback: If readProperties fails, we can't safely continue
                                                    // The structure is corrupted or we're misaligned
                                                    throw new Error(`Failed to parse IconList element ${i + 1}: ${iconListErr.message}`);
                                                }
                                            }
                                        } else {
                                            // ============================================================
                                            // 变长结构体数组：header.Size 是全部元素的总字节数
                                            // 每个元素是独立的 tagged property list，以 "None" 结束，长度各不相同
                                            // 定长切分（size/count）会从第 2 个元素起全部错位 —— 必须按 None 边界走
                                            // ============================================================
                                            if (isTotalSizeFormat && !shouldParseAsStruct) {
                                                const arrayDataEnd = arrayStartOffset + size;
                                                let ok = true;
                                                for (let i = 0; i < elementCount; i++) {
                                                    const elementStart = this.getOffset();
                                                    if (elementStart >= arrayDataEnd) { ok = false; break; }
                                                    try {
                                                        const elementProps = this.readProperties(arrayDataEnd);
                                                        if (Array.isArray(elementProps) && elementProps.length > 0) {
                                                            arr.push(elementProps);
                                                        } else {
                                                            ok = false;
                                                            break;
                                                        }
                                                        if (this.getOffset() <= elementStart) { ok = false; break; }
                                                    } catch (e) {
                                                        if (this.enableDebug) {
                                                            console.warn(`[Reader] variable-size element ${i} failed @ ${this.formatHex(elementStart)}: ${e.message}`);
                                                        }
                                                        ok = false;
                                                        break;
                                                    }
                                                }
                                                if (!ok) {
                                                    // 变长解析不可信：整体退回原始字节，绝不写入错误结构
                                                    this.setOffset(arrayStartOffset + size - (size - (headerReadStart - arrayStartOffset)));
                                                    arr.length = 0;
                                                    this.setOffset(headerReadStart + (this.getOffset() - headerReadStart));
                                                    const dataStart = arrayDataEnd - (size - (headerReadStart - arrayStartOffset));
                                                    this.setOffset(dataStart);
                                                    arr.push(this.readBytes(arrayDataEnd - dataStart));
                                                    if (this.enableDebug) {
                                                        console.warn(`[Reader] '${name}': variable-size parse failed, kept ${arrayDataEnd - dataStart} raw bytes`);
                                                    }
                                                }
                                                value = arr;
                                                isExpandable = true;
                                                if (arrayStructInfo) arrayStructInfo.isVariableSize = true;
                                            } else {
                                            // Non-IconList arrays: use the original size-based logic
                                            for (let i = 0; i < elementCount; i++) {
                                                let sizeToRead = actualElementSize;
                                                if (i === elementCount - 1) {
                                                    sizeToRead += remainder;
                                                }

                                                const currentOffset = this.getOffset();
                                                const maxReadableBytes = bufferSize - currentOffset;
                                                if (sizeToRead > maxReadableBytes) {
                                                    console.warn(`[Reader] Array element ${i + 1}/${elementCount} size ${sizeToRead} exceeds remaining buffer (${maxReadableBytes} bytes). Clamping.`);
                                                    sizeToRead = Math.max(0, maxReadableBytes);
                                                }

                                                try {
                                                    if (sizeToRead > 0) {
                                                        const elementStartOffset = this.getOffset();

                                                        // Try to parse as struct if we have a struct name or if we should try parsing unknown structs
                                                        if (shouldTryParseAsStruct || shouldTryParseUnknown) {
                                                            try {
                                                                const structNameToUse = arrStructName || "UnknownStruct";
                                                                const structValue = this.readStruct(structNameToUse, sizeToRead);
                                                                if (Array.isArray(structValue) && structValue.length > 0) {
                                                                    // Successfully parsed as struct
                                                                    arr.push(structValue);
                                                                    // Verify we consumed the expected amount
                                                                    const consumed = this.getOffset() - elementStartOffset;
                                                                    if (consumed !== sizeToRead && consumed < sizeToRead) {
                                                                        // Didn't consume all bytes, adjust offset
                                                                        this.setOffset(elementStartOffset + sizeToRead);
                                                                    } else if (consumed > sizeToRead) {
                                                                        // Read too much, reset and read as raw
                                                                        this.setOffset(elementStartOffset);
                                                                        const rawChunk = this.readBytes(sizeToRead);
                                                                        arr[arr.length - 1] = rawChunk;
                                                                    }
                                                                } else {
                                                                    // Parsing failed, read as raw bytes
                                                                    this.setOffset(elementStartOffset);
                                                                    const rawChunk = this.readBytes(sizeToRead);
                                                                    arr.push(rawChunk);
                                                                }
                                                            } catch (structErr) {
                                                                // Struct parsing failed, read as raw bytes
                                                                if (this.enableDebug) {
                                                                    console.warn(`[Reader] Failed to parse struct element ${i + 1}/${elementCount} for '${name}': ${structErr.message}. Reading as raw bytes.`);
                                                                }
                                                                this.setOffset(elementStartOffset);
                                                                const rawChunk = this.readBytes(sizeToRead);
                                                                arr.push(rawChunk);
                                                            }
                                                        } else {
                                                            // No struct name or too small, read as raw bytes
                                                            const rawChunk = this.readBytes(sizeToRead);
                                                            arr.push(rawChunk);
                                                        }
                                                    } else {
                                                        arr.push(new Uint8Array(0));
                                                    }
                                                } catch (e) {
                                                    console.error(`[Reader] Error reading raw chunk ${i + 1}/${elementCount} for '${name}': ${e}`);
                                                    arr.push(new Uint8Array(sizeToRead));
                                                }
                                            }
                                            }
                                        }
                                    }
                                    const finalArrayOffset = arrayStartOffset + size;
                                    this.setOffset(finalArrayOffset);
                                    value = arr;
                                    isExpandable = true;
                                }
                            }
                        } else {
                            const simpleArrayStartOffset = startOffset;
                            const headerBytesUsed = this.getOffset() - simpleArrayStartOffset;
                            const remainingArrayBytes = size - headerBytesUsed;
                            const singleSize = elementCount > 0 ? remainingArrayBytes / elementCount : 0;
                            const arr = [];
                            for (let i = 0; i < elementCount; i++) {
                                arr.push(this.readSingleValue(innerType || "IntProperty", singleSize));
                            }
                            const finalArrayOffset = simpleArrayStartOffset + size;
                            const currentOffset = this.getOffset();
                            if (currentOffset !== finalArrayOffset) {
                                if (this.enableDebug) {
                                    this.log(`  -> Array offset correction: ${currentOffset} -> ${finalArrayOffset}`);
                                }
                                this.setOffset(finalArrayOffset);
                            }
                            value = arr;
                            isExpandable = true;
                        }
                        break;
                    case "SetProperty":
                        const setStartOffset = startOffset;
                        const keysToRemove = this.readInt32();
                        const setElementCount = this.readInt32();
                        if (this.enableDebug) {
                            this.log(`  -> Set: KeysToRemove=${keysToRemove}, ElementCount=${setElementCount}`);
                        }
                        if (innerType === "StructProperty") {
                            const setName = this.readFName(this.nameMap);
                            const setPropName = this.readFName(this.nameMap);
                            const setStructSize = this.readInt32();
                            const setStructName = this.readFName(this.nameMap);
                            const setGuid = this.readGuid();
                            const setHasGuid = this.readUInt8();
                            if (this.enableDebug)
                                this.log(`  -> Set Inner Struct: ${setStructName} (Size: ${setStructSize})`);
                            const setStructInfo = {
                                propertyName: setName,
                                propertyType: setPropName,
                                size: setStructSize,
                                structName: setStructName,
                                guid: setGuid,
                                hasGuid: setHasGuid,
                                keysToRemove
                            };
                            const setHeaderBytesUsed = this.getOffset() - setStartOffset;
                            const remainingSetBytes = size - setHeaderBytesUsed;
                            const calculatedSetElementSize = setElementCount > 0 ? Math.floor(remainingSetBytes / setElementCount) : 0;
                            const setRemainder = setElementCount > 0 ? remainingSetBytes % setElementCount : 0;
                            // Check for struct size mismatch in SetProperty
                            const setStatedTotalSize = setStructSize * setElementCount;
                            const setHasSizeMismatch = setStructSize > 0 && (
                                setStatedTotalSize > remainingSetBytes ||
                                (calculatedSetElementSize > 0 && Math.abs(setStructSize - calculatedSetElementSize) > 4)
                            );
                            if (setHasSizeMismatch && this.enableDebug) {
                                console.warn(`[Reader] SetProperty Struct Size Mismatch for '${name}'. Stated: ${setStructSize} * ${setElementCount} = ${setStatedTotalSize} > Available: ${remainingSetBytes}. Using calculated size: ${calculatedSetElementSize} bytes per element.`);
                                setStructInfo.size = calculatedSetElementSize;
                            }
                            const setArr = [];
                            const actualSetElementSize = setHasSizeMismatch ? calculatedSetElementSize : setStructSize;
                            for (let i = 0; i < setElementCount; i++) {
                                let setSizeToRead = actualSetElementSize;
                                if (i === setElementCount - 1) {
                                    setSizeToRead += setRemainder;
                                }
                                const setElementStart = this.getOffset();
                                try {
                                    const setStructValue = this.readStruct(setStructName, setSizeToRead);
                                    if (Array.isArray(setStructValue)) {
                                        setArr.push(setStructValue);
                                    } else {
                                        this.setOffset(setElementStart);
                                        const rawChunk = this.readBytes(setSizeToRead);
                                        setArr.push(rawChunk);
                                    }
                                } catch (e) {
                                    console.error(`[Reader] Error parsing set struct element ${i + 1}/${setElementCount}: ${e}`);
                                    this.setOffset(setElementStart);
                                    const rawChunk = this.readBytes(setSizeToRead);
                                    setArr.push(rawChunk);
                                }
                            }
                            const finalSetOffset = setStartOffset + size;
                            this.setOffset(finalSetOffset);
                            value = setArr;
                            arrayStructInfo = setStructInfo;
                        } else {
                            const setHeaderBytesUsed = this.getOffset() - setStartOffset;
                            const remainingSetBytes = size - setHeaderBytesUsed;
                            const singleSetSize = setElementCount > 0 ? remainingSetBytes / setElementCount : 0;
                            const setArr = [];
                            for (let i = 0; i < setElementCount; i++) {
                                setArr.push(this.readSingleValue(innerType || "IntProperty", singleSetSize));
                            }
                            const finalSetOffset = setStartOffset + size;
                            const currentSetOffset = this.getOffset();
                            if (currentSetOffset !== finalSetOffset) {
                                if (this.enableDebug) {
                                    this.log(`  -> Set offset correction: ${currentSetOffset} -> ${finalSetOffset}`);
                                }
                                this.setOffset(finalSetOffset);
                            }
                            value = setArr;
                            arrayStructInfo = { keysToRemove };
                        }
                        isExpandable = true;
                        break;
                    case "MapProperty":
                        // MapProperty serialization is complex and varies by key/value types
                        // To ensure byte-perfect round-trip, always preserve as raw bytes
                        const mapRawData = this.readBytes(size);
                        value = {
                            _isRawMapData: true,
                            rawData: mapRawData
                        };
                        isExpandable = false;
                        if (this.enableDebug) {
                            this.log(`  -> MapProperty preserved as raw bytes: ${size} bytes`);
                        }
                        break;
                    default:
                        this.setOffset(startOffset + size);
                        value = `Unsupported Type (${type})`;
                        break;
                }
            } catch (err) {
                console.warn(`[Reader] Property '${name}' (${type}) read error, preserving raw bytes. Reason: ${err}`);
                this.setOffset(startOffset);
                try {
                    const maxReadableBytes = this.getBufferSize() - startOffset;
                    const bytesToRead = Math.min(size, maxReadableBytes);
                    if (bytesToRead > 0 && bytesToRead <= size) {
                        value = this.readBytes(bytesToRead);
                        if (value.length < size) {
                            const paddedValue = new Uint8Array(size);
                            paddedValue.set(value, 0);
                            value = paddedValue;
                        }
                    } else {
                        value = new Uint8Array(size);
                    }
                } catch (readErr) {
                    console.warn(`[Reader] Raw byte read also failed for property '${name}', using zero-filled array. Reason: ${readErr}`);
                    value = new Uint8Array(size);
                }
                this.setOffset(startOffset + size);
                usedRawBytesFallback = true;
            }
            let paddingData = void 0;
            if (!usedRawBytesFallback) {
                const bytesRead = this.getOffset() - startOffset;
                const remainingBytes = size - bytesRead;
                if (remainingBytes > 0) {
                    if (this.enableDebug)
                        this.log(`  -> PADDING DETECTED: Expected ${size}, Read ${bytesRead}, Remaining ${remainingBytes} bytes.`);
                    try {
                        paddingData = this.readBytes(remainingBytes);
                    } catch (paddingErr) {
                        if (this.enableDebug) {
                            console.warn(`[Reader] Padding read failed for property '${name}', using empty padding. Reason: ${paddingErr}`);
                        }
                        paddingData = new Uint8Array(0);
                    }
                } else if (remainingBytes < 0) {
                    console.warn(`[Reader] OVERREAD detected in '${name}': Read ${bytesRead} bytes but size was ${size}. Preserving raw bytes.`);
                    this.setOffset(startOffset);
                    try {
                        const maxReadableBytes = this.getBufferSize() - startOffset;
                        const bytesToRead = Math.min(size, maxReadableBytes);
                        if (bytesToRead > 0 && bytesToRead <= size) {
                            value = this.readBytes(bytesToRead);
                            if (value.length < size) {
                                const paddedValue = new Uint8Array(size);
                                paddedValue.set(value, 0);
                                value = paddedValue;
                            }
                        } else {
                            value = new Uint8Array(size);
                        }
                    } catch (readErr) {
                        console.warn(`[Reader] Raw byte read failed for overread property '${name}', using zero-filled array. Reason: ${readErr}`);
                        value = new Uint8Array(size);
                    }
                    this.setOffset(startOffset + size);
                    usedRawBytesFallback = true;
                }
            }
            // Capture originalBytes for StructProperty and ArrayProperty (for raw preservation mode)
            let originalBytes = void 0;
            if (type === "StructProperty" || type === "ArrayProperty") {
                const currentOffset = this.getOffset();
                this.setOffset(startOffset);
                originalBytes = this.readBytes(size);
                this.setOffset(currentOffset);
            }

            properties.push({
                name,
                type,
                size,
                arrayIndex,
                value,
                structName,
                innerType,
                valueType,
                enumName,
                isExpandable,
                rawIndex,
                arrayStructInfo,
                propertyGuid,
                structHeaderGuid,
                paddingData,
                originalBytes,
                isModified: false,  // Track modification state
                // --- 以下为 uasset-studio 增加的定位信息，用于「就地字节补丁」---
                __tagStart: currentPos,
                __payloadOffset: startOffset,
                __boolOffset: boolOffset
            });
        }
        return properties;
    }
    readFloat() {
        const view = this.getCurrentView();
        const val = view.getFloat32(this.getCurrentOffset(), this.littleEndian);
        this.offset += 4;
        return val;
    }
};

var UAssetBinaryWriter = class {
    constructor(initialCapacity = 1024 * 1024) {
        __publicField(this, "buffer");
        __publicField(this, "view");
        __publicField(this, "offset", 0);
        __publicField(this, "capacity");
        this.capacity = initialCapacity;
        this.buffer = new Uint8Array(this.capacity);
        this.view = new DataView(this.buffer.buffer);
    }

    ensureCapacity(additionalSize) {
        if (this.offset + additionalSize > this.capacity) {
            let newCapacity = this.capacity * 2;
            while (newCapacity < this.offset + additionalSize) {
                newCapacity *= 2;
            }
            const newBuffer = new Uint8Array(newCapacity);
            newBuffer.set(this.buffer);
            this.buffer = newBuffer;
            this.view = new DataView(this.buffer.buffer);
            this.capacity = newCapacity;
        }
    }
    getBuffer() {
        return this.buffer.slice(0, this.offset);
    }
    getPosition() {
        return this.offset;
    }
    seek(pos) {
        this.offset = pos;
    }

    writeInt32(val) {
        this.ensureCapacity(4);
        this.view.setInt32(this.offset, val, true);
        this.offset += 4;
    }
    writeUInt32(val) {
        this.ensureCapacity(4);
        this.view.setUint32(this.offset, val, true);
        this.offset += 4;
    }
    writeInt16(val) {
        this.ensureCapacity(2);
        this.view.setInt16(this.offset, val, true);
        this.offset += 2;
    }
    writeUInt16(val) {
        this.ensureCapacity(2);
        this.view.setUint16(this.offset, val, true);
        this.offset += 2;
    }
    writeUInt8(val) {
        this.ensureCapacity(1);
        this.view.setUint8(this.offset, val);
        this.offset += 1;
    }
    writeInt8(val) {
        this.ensureCapacity(1);
        this.view.setInt8(this.offset, val);
        this.offset += 1;
    }
    writeFloat(val) {
        this.ensureCapacity(4);
        this.view.setFloat32(this.offset, val, true);
        this.offset += 4;
    }
    writeDouble(val) {
        this.ensureCapacity(8);
        this.view.setFloat64(this.offset, val, true);
        this.offset += 8;
    }
    writeUInt64(val) {
        this.ensureCapacity(8);
        const bigVal = BigInt(val);
        this.view.setBigUint64(this.offset, bigVal, true);
        this.offset += 8;
    }
    writeInt64(val) {
        this.ensureCapacity(8);
        const bigVal = BigInt(val);
        this.view.setBigInt64(this.offset, bigVal, true);
        this.offset += 8;
    }
    writeBytes(bytes) {
        this.ensureCapacity(bytes.length);
        this.buffer.set(bytes, this.offset);
        this.offset += bytes.length;
    }

    writeFString(str) {
        if (!str || str.length === 0) {
            this.writeInt32(0);
            return;
        }
        const isUnicode = /[^\x00-\x7F]/.test(str);
        if (!isUnicode) {
            this.writeInt32(str.length + 1);
            this.ensureCapacity(str.length + 1);
            for (let i = 0; i < str.length; i++) {
                this.writeUInt8(str.charCodeAt(i));
            }
            this.writeUInt8(0);
        } else {
            this.writeInt32(-(str.length + 1));
            this.ensureCapacity((str.length + 1) * 2);
            for (let i = 0; i < str.length; i++) {
                this.writeUInt16(str.charCodeAt(i));
            }
            this.writeUInt16(0);
        }
    }
};

var UAssetHeaderWriter = class {
    constructor(header) {
        __publicField(this, "writer");
        __publicField(this, "header");
        this.writer = new UAssetBinaryWriter(1024 * 1024);
        this.header = header;
    }

    writeEngineVersion(version) {
        if (!version) {
            this.writer.writeUInt16(0);
            this.writer.writeUInt16(0);
            this.writer.writeUInt16(0);
            this.writer.writeUInt32(0);
            this.writer.writeFString("");
            return;
        }
        this.writer.writeUInt16(version.major || 0);
        this.writer.writeUInt16(version.minor || 0);
        this.writer.writeUInt16(version.patch || 0);
        this.writer.writeUInt32(version.changelist || 0);
        this.writer.writeFString(version.branch || "");
    }

    writeGuid(guidStr) {
        if (!guidStr || guidStr.length === 0) {
            for (let i = 0; i < 16; i++)
                this.writer.writeUInt8(0);
            return;
        }
        const hex = guidStr.replace(/-/g, "");
        if (hex.length !== 32) {
            for (let i = 0; i < 16; i++)
                this.writer.writeUInt8(0);
            return;
        }
        for (let i = 0; i < 32; i += 2) {
            this.writer.writeUInt8(parseInt(hex.substr(i, 2), 16));
        }
    }

    writeHeader(updatedHeader) {
        const h = updatedHeader;
        this.writer.writeUInt32(h.tag);
        this.writer.writeInt32(h.legacyFileVersion);
        this.writer.writeInt32(h.legacyUE3Version);
        this.writer.writeInt32(h.rawFileVersionUE4);
        this.writer.writeInt32(h.fileVersionLicenseeUE4);
        this.writer.writeInt32(h.customVersions.length);
        for (const cv of h.customVersions) {
            this.writeGuid(cv.key);
            this.writer.writeInt32(cv.version);
        }
        this.writer.writeInt32(h.totalHeaderSize);
        this.writer.writeFString(h.folderName);
        this.writer.writeUInt32(h.packageFlags);
        this.writer.writeInt32(h.nameCount);
        this.writer.writeInt32(h.nameOffset);
        if (h.rawFileVersionUE4 !== 0 && h.rawFileVersionUE4 >= 459) {
            this.writer.writeFString(h.localizationId || "");
        }
        if (h.fileVersionUE4 >= 456) {
            this.writer.writeInt32(h.gatherableTextDataCount || 0);
            this.writer.writeInt32(h.gatherableTextDataOffset || 0);
        }
        this.writer.writeInt32(h.exportCount);
        this.writer.writeInt32(h.exportOffset);
        this.writer.writeInt32(h.importCount);
        this.writer.writeInt32(h.importOffset);
        this.writer.writeInt32(h.dependsOffset);
        if (h.fileVersionUE4 >= 384) {
            this.writer.writeInt32(h.softPackageReferencesCount || 0);
            this.writer.writeInt32(h.softPackageReferencesOffset || 0);
        }
        if (h.fileVersionUE4 >= 510) {
            this.writer.writeInt32(h.searchableNamesOffset || 0);
        }
        this.writer.writeInt32(h.thumbnailTableOffset);
        this.writeGuid(h.guid);
        this.writer.writeInt32(h.generations.length);
        for (const gen of h.generations) {
            this.writer.writeInt32(gen.exportCount);
            this.writer.writeInt32(gen.nameCount);
        }
        this.writeEngineVersion(h.savedByEngineVersion);
        if (h.fileVersionUE4 >= 336) {
            this.writeEngineVersion(h.compatibleWithEngineVersion);
        }
        this.writer.writeUInt32(h.compressionFlags);
        this.writer.writeInt32(h.compressedChunks.length);
        for (const chunk of h.compressedChunks) {
            this.writer.writeInt32(chunk.uncompressedOffset);
            this.writer.writeInt32(chunk.uncompressedSize);
            this.writer.writeInt32(chunk.compressedOffset);
            this.writer.writeInt32(chunk.compressedSize);
        }
        this.writer.writeUInt32(h.packageSource);
        this.writer.writeInt32(h.additionalPackagesToCook.length);
        for (const pkg of h.additionalPackagesToCook) {
            this.writer.writeFString(pkg);
        }
        this.writer.writeInt32(h.assetRegistryDataOffset);
        this.writer.writeInt32(h.bulkDataStartOffset);
        if (h.fileVersionUE4 >= 224) {
            this.writer.writeInt32(h.worldTileInfoDataOffset || 0);
        }
        if (h.fileVersionUE4 >= 326) {
            this.writer.writeInt32(h.chunkIDs.length);
            for (const id of h.chunkIDs) {
                this.writer.writeInt32(id);
            }
        } else if (h.fileVersionUE4 >= 278) {
            this.writer.writeInt32(h.chunkIDs && h.chunkIDs.length > 0 ? h.chunkIDs[0] : 0);
        }
        if (h.fileVersionUE4 >= 365) {
            this.writer.writeInt32(h.preloadDependencyCount || 0);
            this.writer.writeInt32(h.preloadDependencyOffset || 0);
        }
    }

    writeNameMap(nameMap, fileVersionUE4) {
        for (let i = 0; i < nameMap.length; i++) {
            this.writer.writeFString(nameMap[i]);
            if (fileVersionUE4 >= 504) {
                this.writer.writeUInt16(0);
                this.writer.writeUInt16(0);
            }
        }
    }

    writeImport(imp) {
        this.writer.writeInt32(imp.classPackageIndex);
        this.writer.writeInt32(0);
        this.writer.writeInt32(imp.classNameIndex);
        this.writer.writeInt32(0);
        this.writer.writeInt32(imp.outerIndex);
        this.writer.writeInt32(imp.objectNameIndex);
        this.writer.writeInt32(0);
    }

    writeExport(exp, fileVersionUE4) {
        // Use global debug function instead of class property
        const debugEnabled = isDebugEnabled();
        const startPos = this.writer.getPosition();

        this.writer.writeInt32(exp.classIndex);
        this.writer.writeInt32(exp.superIndex);
        this.writer.writeInt32(exp.templateIndex);
        this.writer.writeInt32(exp.outerIndex);
        this.writer.writeInt32(exp.objectNameIndex);
        this.writer.writeInt32(0);
        this.writer.writeUInt32(exp.objectFlags);

        // Ensure serialSize is never negative (it's a count/size, must be >= 0)
        let serialSize = Number(exp.serialSize) || 0;
        if (serialSize < 0) {
            const msg = `[writeExport] Negative serialSize detected: ${serialSize}, clamping to 0`;
            console.warn(msg);
            if (debugEnabled) debugWarn(msg);
            serialSize = 0;
        }

        // Ensure serialOffset is valid
        let serialOffset = Number(exp.serialOffset) || 0;
        if (serialOffset < 0) {
            const msg = `[writeExport] Negative serialOffset detected: ${serialOffset}, clamping to 0`;
            console.warn(msg);
            if (debugEnabled) debugWarn(msg);
            serialOffset = 0;
        }

        if (fileVersionUE4 < 508) {
            // For Int32 format, ensure values fit within signed 32-bit range
            // Max signed Int32: 2,147,483,647 (0x7FFFFFFF)
            const MAX_INT32 = 2147483647;
            if (serialSize > MAX_INT32) {
                const msg = `[writeExport] serialSize ${serialSize} exceeds Int32 max, clamping to ${MAX_INT32}`;
                console.warn(msg);
                if (debugEnabled) debugWarn(msg);
                serialSize = MAX_INT32;
            }
            if (serialOffset > MAX_INT32) {
                const msg = `[writeExport] serialOffset ${serialOffset} exceeds Int32 max, clamping to ${MAX_INT32}`;
                console.warn(msg);
                if (debugEnabled) debugWarn(msg);
                serialOffset = MAX_INT32;
            }

            if (debugEnabled) {
                debugLog(`[writeExport]   - Writing Int32: serialSize=${serialSize}, serialOffset=${serialOffset}`);
            }

            this.writer.writeInt32(serialSize);
            this.writer.writeInt32(serialOffset);
        } else {
            // For Int64 format, ensure values are properly converted
            // JavaScript Number can safely represent integers up to 2^53 - 1
            // For Int64, we use BigInt which can handle full 64-bit range
            const bigSerialSize = BigInt(Math.floor(serialSize));
            const bigSerialOffset = BigInt(Math.floor(serialOffset));

            if (debugEnabled) {
                debugLog(`[writeExport]   - Writing Int64: serialSize=${bigSerialSize}, serialOffset=${bigSerialOffset}`);
            }

            this.writer.writeInt64(bigSerialSize);
            this.writer.writeInt64(bigSerialOffset);
        }

        // Continue writing remaining export fields
        this.writer.writeInt32(exp.bForcedExport ? 1 : 0);
        this.writer.writeInt32(exp.bNotForClient ? 1 : 0);
        this.writer.writeInt32(exp.bNotForServer ? 1 : 0);
        this.writeGuid(exp.packageGuid);
        this.writer.writeUInt32(exp.packageFlags);
        if (fileVersionUE4 >= 365) {
            this.writer.writeInt32(exp.bNotAlwaysLoadedForEditorGame ? 1 : 0);
        }
        if (fileVersionUE4 >= 465) {
            this.writer.writeInt32(exp.bIsAsset ? 1 : 0);
        }
        if (fileVersionUE4 >= 507) {
            this.writer.writeInt32(exp.firstExportDependency || 0);
            this.writer.writeInt32(exp.serializationBeforeSerializationDependencies || 0);
            this.writer.writeInt32(exp.createBeforeSerializationDependencies || 0);
            this.writer.writeInt32(exp.serializationBeforeCreateDependencies || 0);
            this.writer.writeInt32(exp.createBeforeCreateDependencies || 0);
        }

        // Debug log at the END after all fields are written
        if (debugEnabled) {
            const endPos = this.writer.getPosition();
            const written = endPos - startPos;
            // Calculate expected size correctly:
            // Base: 28 bytes (6*Int32 + UInt32)
            // SerialSize/Offset: 8 bytes (Int32) if < 508, 16 bytes (Int64) if >= 508
            // bForcedExport, bNotForClient, bNotForServer: 12 bytes (3*Int32)
            // GUID: 16 bytes
            // packageFlags: 4 bytes (UInt32)
            // bNotAlwaysLoadedForEditorGame (>= 365): 4 bytes
            // bIsAsset (>= 465): 4 bytes
            // Dependencies (>= 507): 20 bytes (5*Int32)
            const baseSize = 28; // 6*Int32 + UInt32
            const serialSize = fileVersionUE4 < 508 ? 8 : 16; // Int32 vs Int64
            const boolFields = 12; // 3*Int32 (bForcedExport, bNotForClient, bNotForServer)
            const guidSize = 16;
            const packageFlagsSize = 4; // UInt32
            const optionalSize =
                (fileVersionUE4 >= 365 ? 4 : 0) + // bNotAlwaysLoadedForEditorGame
                (fileVersionUE4 >= 465 ? 4 : 0) + // bIsAsset
                (fileVersionUE4 >= 507 ? 20 : 0); // Dependencies

            const expectedSize = baseSize + serialSize + boolFields + guidSize + packageFlagsSize + optionalSize;
            debugLog(`[writeExport]   - Wrote ${written} bytes (expected: ${expectedSize} bytes, fileVersionUE4=${fileVersionUE4})`);
            if (written !== expectedSize) {
                debugWarn(`[writeExport]   - SIZE MISMATCH! Written ${written} but expected ${expectedSize}`);
            }
        }
    }

    getBuffer() {
        return this.writer.getBuffer();
    }

    getPosition() {
        return this.writer.getPosition();
    }
};

var UAssetPropertyWriter = class _UAssetPropertyWriter {
    constructor(writer, nameMap, enableDebug = false) {
        __publicField(this, "writer");
        __publicField(this, "nameMap");
        __publicField(this, "enableDebug");
        this.writer = writer;
        this.nameMap = nameMap;
        this.enableDebug = enableDebug;
    }

    log(msg) {
        if (this.enableDebug) {
            debugLog(`[WRITE] ${msg}`, "color: #ff00ff");
        }
    }
    formatHex(offset) {
        return `0x${offset.toString(16).toUpperCase().padStart(8, "0")}`;
    }
    formatGuid(guid) {
        if (!guid || guid === "00000000-0000-0000-0000-000000000000") {
            return "00000000-0000-0000-0000-000000000000 (all zeros)";
        }
        return guid;
    }
    getCurrentOffset() {
        return this.writer.getPosition();
    }

    writeFName(name) {
        debugLog(`[UPDATE] Writing FName: '${name}'`);
        const unknownMatch = name.match(/^Unknown_(-?\d+)_(-?\d+)$/);
        if (unknownMatch) {
            const index2 = parseInt(unknownMatch[1]);
            const number = parseInt(unknownMatch[2]);
            debugLog(`[UPDATE] Writing Unknown format: index=${index2}, number=${number}`);
            this.writer.writeInt32(index2);
            this.writer.writeInt32(number);
            return;
        }
        // First, check if the full string exists in NameMap
        let index = this.nameMap.indexOf(name);
        if (index !== -1) {
            debugLog(`[UPDATE] Found name '${name}' at index ${index} in NameMap`);
            this.writer.writeInt32(index);
            this.writer.writeInt32(0);
            return;
        }
        // Only attempt to split if the full string does NOT exist in NameMap
        // This prevents splitting file paths like /Game/Path_To_Asset_01 incorrectly
        const match = name.match(/^(.*)_(-?\d+)$/);
        if (match) {
            const baseName = match[1];
            const suffix = parseInt(match[2]);
            index = this.nameMap.indexOf(baseName);
            if (index !== -1) {
                const numberToWrite = suffix >= 0 ? suffix + 1 : suffix;
                debugLog(`[UPDATE] Full name not found, split to base '${baseName}' at index ${index}, writing with suffix ${numberToWrite}`);
                this.writer.writeInt32(index);
                this.writer.writeInt32(numberToWrite);
                return;
            }
        }
        debugWarn(`[UPDATE] Warning: Name '${name}' not found in NameMap (size: ${this.nameMap.length})! Writing None.`);
        this.writer.writeInt32(0);
        this.writer.writeInt32(0);
    }
    writeGuid(guidStr) {
        if (!guidStr || guidStr.length === 0) {
            for (let i = 0; i < 16; i++)
                this.writer.writeUInt8(0);
            return;
        }
        const hex = guidStr.replace(/-/g, "");
        if (hex.length !== 32) {
            for (let i = 0; i < 16; i++)
                this.writer.writeUInt8(0);
            return;
        }
        for (let i = 0; i < 32; i += 2) {
            this.writer.writeUInt8(parseInt(hex.substr(i, 2), 16));
        }
    }
    writeSingleValue(type, value, rawIndex) {
        switch (type) {
            case "Int8Property":
                this.writer.writeInt8(Number(value) | 0);
                break;
            case "Int16Property":
                this.writer.writeInt16(Number(value) | 0);
                break;
            case "Int64Property":
                try { this.writer.writeInt64(BigInt(String(value).trim())); } catch { this.writer.writeInt64(BigInt(0)); }
                break;
            case "UInt16Property":
                this.writer.writeUInt16(Number(value) & 0xFFFF);
                break;
            case "AnsiStrProperty":
            case "Utf8StrProperty":
                this.writer.writeFString(String(value));
                break;
            case "ClassProperty":
            case "InterfaceProperty":
            case "WeakObjectProperty":
                this.writer.writeInt32(Number(value) || 0);
                break;
            case "AssetObjectProperty":
            case "AssetClassProperty":
            case "SoftClassProperty":
                if (typeof value === "object" && value !== null && value.assetPathName !== void 0) {
                    this.writeFName(value.assetPathName);
                    this.writer.writeFString(value.subPathString || "");
                } else {
                    this.writeFName("None");
                    this.writer.writeFString("");
                }
                break;
            case "LazyObjectProperty":
                if (value instanceof Uint8Array && value.length === 16) {
                    this.writer.writeBytes(value);
                } else {
                    for (var _i = 0; _i < 16; _i++) this.writer.writeUInt8(0);
                }
                break;
            case "BoolProperty":
                this.writer.writeUInt8(value ? 1 : 0);
                break;
            case "IntProperty":
                this.writer.writeInt32(Number(value));
                break;
            case "UInt32Property":
                this.writer.writeUInt32(Number(value));
                break;
            case "UInt64Property":
                try {
                    let val64 = value;
                    if (typeof val64 === "string") {
                        val64 = val64.split(" ")[0].trim();
                        if (!val64.startsWith("0x") && !val64.startsWith("0X")) {
                            const hexPattern = /^[0-9A-Fa-f]+$/;
                            if (hexPattern.test(val64)) {
                                val64 = "0x" + val64;
                            }
                        }
                    }
                    this.writer.writeUInt64(BigInt(val64));
                } catch {
                    this.writer.writeUInt64(0);
                }
                break;
            case "FloatProperty":
                this.writer.writeFloat(Number(value));
                break;
            case "DoubleProperty":
                this.writer.writeDouble(Number(value));
                break;
            case "StrProperty":
                this.writer.writeFString(String(value));
                break;
            case "NameProperty":
                this.writeFName(String(value));
                break;
            case "ObjectProperty":
                if (rawIndex !== void 0) {
                    this.writer.writeInt32(rawIndex);
                } else {
                    const numValue = Number(value);
                    if (!isNaN(numValue) && numValue !== 0)
                        this.writer.writeInt32(numValue);
                    else
                        this.writer.writeInt32(0);
                }
                break;
            case "SoftObjectProperty":
                if (typeof value === "object" && value.assetPathName !== void 0) {
                    this.writeFName(value.assetPathName);
                    this.writer.writeFString(value.subPathString || "");
                    if (this.enableDebug) {
                        this.log(`  -> SoftObjectProperty: AssetPathName="${value.assetPathName}", SubPathString="${value.subPathString || ""}"`);
                    }
                } else {
                    this.writeFName("None");
                    this.writer.writeFString("");
                }
                break;
            case "TextProperty":
                if (typeof value === "object" && value.flags !== void 0) {
                    this.writer.writeUInt32(value.flags || 0);
                    this.writer.writeUInt8(value.historyType || 0);
                    this.writer.writeFString(value.namespace || "");
                    this.writer.writeFString(value.key || "");
                    this.writer.writeFString(value.sourceString || "");
                    if (this.enableDebug) {
                        this.log(`  -> FText: Flags=${value.flags}, HistoryType=${value.historyType}, Namespace="${value.namespace}", Key="${value.key}", Source="${value.sourceString}"`);
                    }
                } else {
                    this.writer.writeUInt32(0);
                    this.writer.writeUInt8(0);
                    this.writer.writeFString("");
                    this.writer.writeFString("");
                    this.writer.writeFString(String(value || ""));
                }
                break;
            case "ByteProperty":
            case "EnumProperty":
                if (typeof value === "string")
                    this.writeFName(value);
                else
                    this.writer.writeUInt8(Number(value));
                break;
            case "DelegateProperty":
                if (typeof value === "object" && value !== null) {
                    this.writer.writeInt32(value.rawIndex !== void 0 ? value.rawIndex : 0);
                    this.writeFName(value.functionName || "None");
                } else {
                    this.writer.writeInt32(0);
                    this.writeFName("None");
                }
                break;
            case "MulticastDelegateProperty":
                if (Array.isArray(value)) {
                    this.writer.writeInt32(value.length);
                    for (const item of value) {
                        this.writer.writeInt32(item.rawIndex !== void 0 ? item.rawIndex : 0);
                        this.writeFName(item.functionName || "None");
                    }
                } else {
                    this.writer.writeInt32(0);
                }
                break;
            default:
                break;
        }
    }

    writeProperties(properties) {
        for (const prop of properties) {
            const tempWriter = new UAssetBinaryWriter();
            const tempPropWriter = new _UAssetPropertyWriter(tempWriter, this.nameMap, this.enableDebug);
            tempPropWriter.writePayload(prop);
            if (prop.paddingData && prop.paddingData.length > 0) {
                tempWriter.writeBytes(prop.paddingData);
            }
            const payloadBytes = tempWriter.getBuffer();
            const payloadSize = payloadBytes.length;
            const startOffset = this.writer.getPosition();
            if (this.enableDebug) {
                this.log(`@ ${this.formatHex(startOffset)} | Prop: ${prop.name} | Type: ${prop.type} | CalcSize: ${payloadSize}`);
            }
            this.writeFName(prop.name);
            this.writeFName(prop.type);
            this.writer.writeInt32(payloadSize);
            this.writer.writeInt32(prop.arrayIndex);
            if (prop.type === "StructProperty") {
                this.writeFName(prop.structName || "None");
                if (prop.structHeaderGuid) {
                    if (this.enableDebug)
                        this.log(`  -> Struct Header GUID: Writing ${this.formatGuid(prop.structHeaderGuid)}`);
                    this.writeGuid(prop.structHeaderGuid);
                } else {
                    if (this.enableDebug)
                        this.log(`  -> Struct Header GUID: Writing 16 zero bytes.`);
                    for (let i = 0; i < 16; i++)
                        this.writer.writeUInt8(0);
                }
            } else if (prop.type === "ArrayProperty") {
                this.writeFName(prop.innerType || "None");
            } else if (prop.type === "ByteProperty" || prop.type === "EnumProperty") {
                this.writeFName(prop.enumName || "None");
            } else if (prop.type === "BoolProperty") {
                this.writer.writeUInt8(prop.value ? 1 : 0);
            } else if (prop.type === "MapProperty") {
                this.writeFName(prop.innerType || "None");
                this.writeFName(prop.valueType || "None");
            } else if (prop.type === "SetProperty") {
                this.writeFName(prop.innerType || "None");
            }
            if (prop.propertyGuid) {
                if (this.enableDebug)
                    this.log(`  -> HasPropertyGuid: 1 (True), GUID: ${prop.propertyGuid}`);
                this.writer.writeUInt8(1);
                this.writeGuid(prop.propertyGuid);
            } else {
                if (this.enableDebug)
                    this.log(`  -> HasPropertyGuid: 0 (False)`);
                this.writer.writeUInt8(0);
            }
            this.writer.writeBytes(payloadBytes);
            if (this.enableDebug && prop.paddingData && prop.paddingData.length > 0) {
                this.log(`  -> Padding Written: ${prop.paddingData.length} bytes`);
            }
        }
        if (this.enableDebug)
            this.log(`@ ${this.formatHex(this.writer.getPosition())} Writing 'None' Terminator.`);
        this.writeFName("None");
    }

    writePayload(prop) {
        // Raw Preservation Mode: If property has originalBytes and is not modified, write raw bytes directly
        if (prop.originalBytes && !prop.isModified) {
            if (this.enableDebug) {
                this.log(`[RAW PRESERVE] Writing original bytes for '${prop.name}' (${prop.originalBytes.length} bytes) - property not modified`);
            }
            this.writer.writeBytes(prop.originalBytes);
            return;
        }

        if (prop.value instanceof Uint8Array && prop.structName !== "Guid") {
            this.writer.writeBytes(prop.value);
            return;
        }
        switch (prop.type) {
            case "Int8Property":
                this.writer.writeInt8(Number(prop.value) | 0);
                break;
            case "Int16Property":
                this.writer.writeInt16(Number(prop.value) | 0);
                break;
            case "Int64Property":
                try { this.writer.writeInt64(BigInt(String(prop.value).trim())); } catch { this.writer.writeInt64(BigInt(0)); }
                break;
            case "UInt16Property":
                this.writer.writeUInt16(Number(prop.value) & 0xFFFF);
                break;
            case "AnsiStrProperty":
            case "Utf8StrProperty":
                this.writer.writeFString(String(prop.value === undefined ? "" : prop.value));
                break;
            case "ClassProperty":
            case "InterfaceProperty":
            case "WeakObjectProperty":
                if (prop.rawIndex !== void 0) {
                    this.writer.writeInt32(prop.rawIndex);
                } else {
                    this.writer.writeInt32(Number(prop.value) || 0);
                }
                break;
            case "AssetObjectProperty":
            case "AssetClassProperty":
            case "SoftClassProperty":
                if (typeof prop.value === "object" && prop.value !== null && prop.value.assetPathName !== void 0) {
                    this.writeFName(prop.value.assetPathName);
                    this.writer.writeFString(prop.value.subPathString || "");
                } else {
                    this.writeFName("None");
                    this.writer.writeFString("");
                }
                break;
            case "LazyObjectProperty":
                if (prop.value instanceof Uint8Array && prop.value.length === 16) {
                    this.writer.writeBytes(prop.value);
                } else {
                    for (var _j = 0; _j < 16; _j++) this.writer.writeUInt8(0);
                }
                break;
            case "BoolProperty":
                break;
            case "IntProperty":
                this.writer.writeInt32(Number(prop.value));
                break;
            case "UInt32Property":
                this.writer.writeUInt32(Number(prop.value));
                break;
            case "UInt64Property":
                let val64 = prop.value;
                if (typeof val64 === "string") {
                    val64 = val64.split(" ")[0].trim();
                    if (!val64.startsWith("0x") && !val64.startsWith("0X")) {
                        const hexPattern = /^[0-9A-Fa-f]+$/;
                        if (hexPattern.test(val64)) {
                            val64 = "0x" + val64;
                        }
                    }
                }
                try {
                    this.writer.writeUInt64(BigInt(val64));
                } catch {
                    this.writer.writeUInt64(0);
                }
                break;
            case "FloatProperty":
                this.writer.writeFloat(Number(prop.value));
                break;
            case "DoubleProperty":
                this.writer.writeDouble(Number(prop.value));
                break;
            case "StrProperty":
                this.writer.writeFString(String(prop.value));
                break;
            case "NameProperty":
                this.writeFName(String(prop.value));
                break;
            case "ObjectProperty":
                if (prop.rawIndex !== void 0) {
                    this.writer.writeInt32(prop.rawIndex);
                } else {
                    this.writer.writeInt32(0);
                }
                break;
            case "SoftObjectProperty":
                if (typeof prop.value === "object" && prop.value.assetPathName !== void 0) {
                    this.writeFName(prop.value.assetPathName);
                    this.writer.writeFString(prop.value.subPathString || "");
                    if (this.enableDebug) {
                        this.log(`  -> SoftObjectProperty: AssetPathName="${prop.value.assetPathName}", SubPathString="${prop.value.subPathString || ""}"`);
                    }
                } else {
                    this.writeFName("None");
                    this.writer.writeFString("");
                }
                break;
            case "TextProperty":
                if (typeof prop.value === "object" && prop.value.flags !== void 0) {
                    const historyType = prop.value.historyType !== void 0 ? prop.value.historyType : 0;
                    this.writer.writeUInt32(prop.value.flags || 0);
                    this.writer.writeInt8(historyType);
                    if (historyType === -1) {
                        if (this.enableDebug) {
                            this.log(`  -> FText: HistoryType=-1 (None), empty text`);
                        }
                    } else if (historyType === 0) {
                        this.writer.writeFString(prop.value.namespace || "");
                        this.writer.writeFString(prop.value.key || "");
                        this.writer.writeFString(prop.value.sourceString || "");
                        if (this.enableDebug) {
                            this.log(`  -> FText: HistoryType=0 (Base), Flags=${prop.value.flags}, Namespace="${prop.value.namespace}", Key="${prop.value.key}", Source="${prop.value.sourceString}"`);
                        }
                    } else {
                        this.writer.writeFString(prop.value.namespace || "");
                        this.writer.writeFString(prop.value.key || "");
                        this.writer.writeFString(prop.value.sourceString || "");
                        if (this.enableDebug) {
                            this.log(`  -> FText: HistoryType=${historyType} (Unknown), attempting Base format. Flags=${prop.value.flags}, Namespace="${prop.value.namespace}", Key="${prop.value.key}", Source="${prop.value.sourceString}"`);
                        }
                    }
                } else {
                    this.writer.writeUInt32(0);
                    this.writer.writeInt8(0);
                    this.writer.writeFString("");
                    this.writer.writeFString("");
                    this.writer.writeFString(String(prop.value || ""));
                }
                break;
            case "ByteProperty":
            case "EnumProperty":
                if (typeof prop.value === "string") {
                    this.writeFName(prop.value);
                } else {
                    this.writer.writeUInt8(Number(prop.value));
                }
                break;
            case "DelegateProperty":
                // Delegate properties often have padding - preserve original bytes if not modified
                if (prop.originalBytes && !prop.isModified) {
                    if (this.enableDebug) {
                        this.log(`[RAW PRESERVE] Writing original bytes for DelegateProperty '${prop.name}' (${prop.originalBytes.length} bytes)`);
                    }
                    this.writer.writeBytes(prop.originalBytes);
                    break;
                }
                if (typeof prop.value === "object" && prop.value !== null && prop.value.rawIndex !== void 0) {
                    this.writer.writeInt32(prop.value.rawIndex);
                    this.writeFName(prop.value.functionName || "None");
                } else {
                    this.writer.writeInt32(0);
                    this.writeFName("None");
                }
                break;
            case "MulticastDelegateProperty":
                if (prop.originalBytes && !prop.isModified) {
                    if (this.enableDebug) {
                        this.log(`[RAW PRESERVE] Writing original bytes for MulticastDelegateProperty '${prop.name}' (${prop.originalBytes.length} bytes)`);
                    }
                    this.writer.writeBytes(prop.originalBytes);
                    break;
                }
                if (Array.isArray(prop.value)) {
                    this.writer.writeInt32(prop.value.length);
                    for (const item of prop.value) {
                        this.writer.writeInt32(item.rawIndex !== void 0 ? item.rawIndex : 0);
                        this.writeFName(item.functionName || "None");
                    }
                } else {
                    this.writer.writeInt32(0);
                }
                break;
            case "StructProperty":
                const sName = prop.structName || "";
                // Check if struct value has _rawBytes and property is not modified
                if (Array.isArray(prop.value) && prop.value._rawBytes && !prop.isModified) {
                    if (this.enableDebug) {
                        this.log(`[RAW PRESERVE] Writing struct _rawBytes for '${prop.name}' (${prop.value._rawBytes.length} bytes) - struct not modified`);
                    }
                    this.writer.writeBytes(prop.value._rawBytes);
                    break;
                }
                if (typeof prop.value === "object" && prop.value !== null && prop.value._rawBytes && !prop.isModified) {
                    if (this.enableDebug) {
                        this.log(`[RAW PRESERVE] Writing struct _rawBytes for '${prop.name}' (${prop.value._rawBytes.length} bytes) - struct not modified`);
                    }
                    this.writer.writeBytes(prop.value._rawBytes);
                    break;
                }
                if (sName === "Guid") {
                    if (prop.value instanceof Uint8Array && prop.value.length === 16) {
                        // Raw 16-byte GUID data (e.g., ExpressionGUID in material parameters)
                        // Do NOT write extra Int32 values - just the raw bytes
                        this.writer.writeBytes(prop.value);
                    } else if (typeof prop.value === "string") {
                        this.writeGuid(prop.value);
                        // String GUIDs might need the extra fields in some cases
                        // but for material parameters, this shouldn't be reached
                    } else {
                        if (this.enableDebug)
                            debugWarn(`[Writer] Invalid Guid format (type: ${typeof prop.value}), writing zero GUID.`);
                        for (let i = 0; i < 16; i++)
                            this.writer.writeUInt8(0);
                    }
                    break;
                }
                if (prop.value instanceof Uint8Array) {
                    this.writer.writeBytes(prop.value);
                    break;
                }
                if (Array.isArray(prop.value)) {
                    this.writeProperties(prop.value);
                } else if (typeof prop.value === "object") {
                    const v = prop.value;
                    if (["ColorMaterialInput", "ScalarMaterialInput", "VectorMaterialInput", "ShadingModelMaterialInput"].includes(sName)) {
                        // Write standard fields
                        if (v.rawExpressionIndex !== undefined) {
                            this.writer.writeInt32(v.rawExpressionIndex);
                        } else {
                            this.writer.writeInt32(0); // Fallback
                        }
                        this.writer.writeInt32(v.OutputIndex || 0);
                        this.writeFName(v.InputName || "None");
                        this.writer.writeInt32(v.Mask || 0);
                        this.writer.writeInt32(v.MaskR || 0);
                        this.writer.writeInt32(v.MaskG || 0);
                        this.writer.writeInt32(v.MaskB || 0);
                        this.writer.writeInt32(v.MaskA || 0);

                        // Write Constant
                        if (sName === "ColorMaterialInput") {
                            const c = v.Constant || { r: 0, g: 0, b: 0, a: 0 };
                            this.writer.writeUInt8(c.b || 0);
                            this.writer.writeUInt8(c.g || 0);
                            this.writer.writeUInt8(c.r || 0);
                            this.writer.writeUInt8(c.a || 0);
                        } else if (sName === "ScalarMaterialInput") {
                            this.writer.writeFloat(Number(v.Constant) || 0);
                        } else if (sName === "VectorMaterialInput") {
                            const vec = v.Constant || { x: 0, y: 0, z: 0 };
                            this.writer.writeFloat(vec.x || 0);
                            this.writer.writeFloat(vec.y || 0);
                            this.writer.writeFloat(vec.z || 0);
                        } else if (sName === "ShadingModelMaterialInput") {
                            this.writer.writeUInt32(Number(v.Constant) || 0);
                        }

                        // Write Padding if it exists
                        if (v._padding && v._padding.length > 0) {
                            this.writer.writeBytes(v._padding);
                        }
                    } else if (sName === "Vector" || sName === "Rotator") {
                        this.writer.writeFloat(v.x || 0);
                        this.writer.writeFloat(v.y || 0);
                        this.writer.writeFloat(v.z || 0);
                    } else if (sName === "Vector2D") {
                        this.writer.writeFloat(v.x || 0);
                        this.writer.writeFloat(v.y || 0);
                    } else if (sName === "Quat" || sName === "Vector4") {
                        this.writer.writeFloat(v.x || 0);
                        this.writer.writeFloat(v.y || 0);
                        this.writer.writeFloat(v.z || 0);
                        this.writer.writeFloat(v.w || 0);
                    } else if (sName === "Color") {
                        this.writer.writeUInt8(v.b || 0);
                        this.writer.writeUInt8(v.g || 0);
                        this.writer.writeUInt8(v.r || 0);
                        this.writer.writeUInt8(v.a || 255);
                    } else if (sName === "LinearColor") {
                        this.writer.writeFloat(v.r || 0);
                        this.writer.writeFloat(v.g || 0);
                        this.writer.writeFloat(v.b || 0);
                        this.writer.writeFloat(v.a || 1);
                    } else if (sName === "Plane") {
                        this.writer.writeFloat(v.x || 0);
                        this.writer.writeFloat(v.y || 0);
                        this.writer.writeFloat(v.z || 0);
                        this.writer.writeFloat(v.w || 0);
                    } else if (sName === "IntPoint") {
                        this.writer.writeInt32(v.x || 0);
                        this.writer.writeInt32(v.y || 0);
                    } else if (sName === "Box") {
                        const min = v.min || { x: 0, y: 0, z: 0 };
                        const max = v.max || { x: 0, y: 0, z: 0 };
                        this.writer.writeFloat(min.x); this.writer.writeFloat(min.y); this.writer.writeFloat(min.z);
                        this.writer.writeFloat(max.x); this.writer.writeFloat(max.y); this.writer.writeFloat(max.z);
                        this.writer.writeUInt8(v.isValid !== undefined ? v.isValid : 1);
                    } else if (sName === "Box2D") {
                        const min = v.min || { x: 0, y: 0 };
                        const max = v.max || { x: 0, y: 0 };
                        this.writer.writeFloat(min.x); this.writer.writeFloat(min.y);
                        this.writer.writeFloat(max.x); this.writer.writeFloat(max.y);
                        this.writer.writeUInt8(v.isValid !== undefined ? v.isValid : 1);
                    } else if (sName === "Transform") {
                        const rot = v.rotation || { x: 0, y: 0, z: 0, w: 1 };
                        const trans = v.translation || { x: 0, y: 0, z: 0 };
                        const scale = v.scale3D || { x: 1, y: 1, z: 1 };
                        this.writer.writeFloat(rot.x || 0);
                        this.writer.writeFloat(rot.y || 0);
                        this.writer.writeFloat(rot.z || 0);
                        this.writer.writeFloat(rot.w || 1);
                        this.writer.writeFloat(trans.x || 0);
                        this.writer.writeFloat(trans.y || 0);
                        this.writer.writeFloat(trans.z || 0);
                        this.writer.writeFloat(scale.x || 1);
                        this.writer.writeFloat(scale.y || 1);
                        this.writer.writeFloat(scale.z || 1);
                    } else if (v instanceof Uint8Array) {
                        this.writer.writeBytes(v);
                    }
                }
                break;
            case "ArrayProperty":
                if (Array.isArray(prop.value)) {
                    // Debug: Check physics array conditions
                    if (this.enableDebug && prop.arrayStructInfo) {
                        console.log(`[DEBUG] ArrayProperty '${prop.name}': hasArrayStructInfo=true, isNativePhysicsArray=${prop.arrayStructInfo.isNativePhysicsArray}, hasOriginalBytes=${!!prop.originalBytes}, originalBytesLength=${prop.originalBytes?.length}, isModified=${prop.isModified}`);
                    }

                    // Check for native physics array - use originalBytes for exact byte-for-byte preservation
                    if (prop.arrayStructInfo && prop.arrayStructInfo.isNativePhysicsArray && prop.originalBytes && !prop.isModified) {
                        if (this.enableDebug) {
                            this.log(`[RAW PRESERVE] Physics array '${prop.name}': Writing originalBytes (${prop.originalBytes.length} bytes) - native physics array not modified`);
                        }
                        this.writer.writeBytes(prop.originalBytes);
                        break;
                    }

                    this.writer.writeInt32(prop.value.length);
                    if (prop.innerType === "StructProperty" && prop.arrayStructInfo) {
                        const info = prop.arrayStructInfo;

                        // Physics arrays use native serialization - NO standard header
                        // Elements are written directly after element count
                        // Each element is a complete StructProperty (with header + payload)
                        if (info.isNativePhysicsArray) {
                            if (this.enableDebug) {
                                this.log(`[PHYSICS ARRAY] Writing native physics array '${prop.name}' with ${prop.value.length} elements (no struct array header)`);
                            }
                            // Write each element - each element is a property list containing 
                            // a StructProperty that wraps the actual struct data
                            prop.value.forEach((item, idx) => {
                                if (item instanceof Uint8Array) {
                                    this.writer.writeBytes(item);
                                } else if (Array.isArray(item)) {
                                    // item is a property list (typically containing a single StructProperty)
                                    // Write each property in the list WITHOUT adding extra None terminator
                                    // because the StructProperty's payload already ends with None
                                    for (const elementProp of item) {
                                        const tempWriter = new UAssetBinaryWriter();
                                        const tempPropWriter = new _UAssetPropertyWriter(tempWriter, this.nameMap, this.enableDebug);
                                        tempPropWriter.writePayload(elementProp);
                                        if (elementProp.paddingData && elementProp.paddingData.length > 0) {
                                            tempWriter.writeBytes(elementProp.paddingData);
                                        }
                                        const payloadBytes = tempWriter.getBuffer();
                                        const payloadSize = payloadBytes.length;

                                        // Write property header
                                        this.writeFName(elementProp.name);
                                        this.writeFName(elementProp.type);
                                        this.writer.writeInt32(payloadSize);
                                        this.writer.writeInt32(elementProp.arrayIndex || 0);

                                        if (elementProp.type === "StructProperty") {
                                            this.writeFName(elementProp.structName || "None");
                                            if (elementProp.structHeaderGuid) {
                                                this.writeGuid(elementProp.structHeaderGuid);
                                            } else {
                                                for (let i = 0; i < 16; i++)
                                                    this.writer.writeUInt8(0);
                                            }
                                        }

                                        // HasPropertyGuid
                                        if (elementProp.propertyGuid) {
                                            this.writer.writeUInt8(1);
                                            this.writeGuid(elementProp.propertyGuid);
                                        } else {
                                            this.writer.writeUInt8(0);
                                        }

                                        // Write payload
                                        this.writer.writeBytes(payloadBytes);
                                    }
                                    // NO None terminator here - the StructProperty payload already ends with None
                                }
                            });
                            break;
                        }

                        // Standard struct array header
                        this.writeFName(info.propertyName);
                        this.writeFName(info.propertyType);
                        // Priority order for header size:
                        // 1. Material parameter arrays - use totalDataSize
                        // 2. Arrays with originalHeaderSize (total-size format like AttrModifyItem) - use originalHeaderSize
                        // 3. Default - use per-element size
                        let headerSize;
                        if (info.isMaterialParameterArray && info.totalDataSize !== undefined) {
                            headerSize = info.totalDataSize;
                        } else if (info.originalHeaderSize !== undefined && info.originalHeaderSize > 0) {
                            headerSize = info.originalHeaderSize;
                        } else {
                            headerSize = info.size;
                        }
                        this.writer.writeInt32(headerSize);
                        this.writer.writeInt32(prop.arrayIndex || 0); // CRITICAL: Write the missing Index field (usually 0)
                        this.writeFName(info.structName);
                        this.writeGuid(info.guid);
                        this.writer.writeUInt8(info.hasGuid);
                        prop.value.forEach((item) => {
                            // Check if array element has _rawBytes and array property is not modified
                            if (Array.isArray(item) && item._rawBytes && !prop.isModified) {
                                if (this.enableDebug) {
                                    this.log(`[RAW PRESERVE] Writing array element _rawBytes (${item._rawBytes.length} bytes) - array not modified`);
                                }
                                this.writer.writeBytes(item._rawBytes);
                                return;
                            }
                            if (item instanceof Uint8Array) {
                                this.writer.writeBytes(item);
                            } else if (Array.isArray(item)) {
                                if (item.length === 1 && item[0] && item[0].type === "ByteProperty" && item[0].value instanceof Uint8Array) {
                                    this.writer.writeBytes(item[0].value);
                                } else {
                                    this.writeProperties(item);
                                }
                            } else {
                                const v = item;
                                const sName2 = info.structName;
                                if (sName2 === "Vector" || sName2 === "Rotator") {
                                    this.writer.writeFloat(v.x);
                                    this.writer.writeFloat(v.y);
                                    this.writer.writeFloat(v.z);
                                } else if (sName2 === "Vector2D") {
                                    this.writer.writeFloat(v.x);
                                    this.writer.writeFloat(v.y);
                                } else if (sName2 === "Quat" || sName2 === "Vector4") {
                                    this.writer.writeFloat(v.x);
                                    this.writer.writeFloat(v.y);
                                    this.writer.writeFloat(v.z);
                                    this.writer.writeFloat(v.w);
                                } else if (sName2 === "Color") {
                                    this.writer.writeUInt8(v.b);
                                    this.writer.writeUInt8(v.g);
                                    this.writer.writeUInt8(v.r);
                                    this.writer.writeUInt8(v.a);
                                } else if (sName2 === "LinearColor") {
                                    this.writer.writeFloat(v.r);
                                    this.writer.writeFloat(v.g);
                                    this.writer.writeFloat(v.b);
                                    this.writer.writeFloat(v.a);
                                } else if (sName2 === "Transform") {
                                    const rot = v.rotation || { x: 0, y: 0, z: 0, w: 1 };
                                    const trans = v.translation || { x: 0, y: 0, z: 0 };
                                    const scale = v.scale3D || { x: 1, y: 1, z: 1 };
                                    this.writer.writeFloat(rot.x || 0);
                                    this.writer.writeFloat(rot.y || 0);
                                    this.writer.writeFloat(rot.z || 0);
                                    this.writer.writeFloat(rot.w || 1);
                                    this.writer.writeFloat(trans.x || 0);
                                    this.writer.writeFloat(trans.y || 0);
                                    this.writer.writeFloat(trans.z || 0);
                                    this.writer.writeFloat(scale.x || 1);
                                    this.writer.writeFloat(scale.y || 1);
                                    this.writer.writeFloat(scale.z || 1);
                                } else if (sName2 === "Guid") {
                                    if (typeof v === "string") {
                                        this.writeGuid(v);
                                    } else if (v instanceof Uint8Array && v.length === 16) {
                                        this.writer.writeBytes(v);
                                    } else {
                                        if (this.enableDebug)
                                            debugWarn(`[Writer] Invalid Guid format in array struct, writing zero GUID. Value type: ${typeof v}`);
                                        for (let i = 0; i < 16; i++)
                                            this.writer.writeUInt8(0);
                                    }
                                }
                            }
                        });
                    } else {
                        prop.value.forEach((v) => {
                            this.writeSingleValue(prop.innerType || "IntProperty", v);
                        });
                    }
                }
                break;
            case "SetProperty":
                // SetProperty: If originalBytes exists and not modified, use raw bytes
                if (prop.originalBytes && !prop.isModified) {
                    if (this.enableDebug) {
                        this.log(`[RAW PRESERVE] Writing original bytes for SetProperty '${prop.name}' (${prop.originalBytes.length} bytes)`);
                    }
                    this.writer.writeBytes(prop.originalBytes);
                    break;
                }
                if (Array.isArray(prop.value)) {
                    const keysToRemove = prop.arrayStructInfo && prop.arrayStructInfo.keysToRemove !== void 0 ? prop.arrayStructInfo.keysToRemove : 0;
                    this.writer.writeInt32(keysToRemove);
                    this.writer.writeInt32(prop.value.length);
                    if (this.enableDebug) {
                        this.log(`  -> Set: KeysToRemove=${keysToRemove}, ElementCount=${prop.value.length}`);
                    }
                    if (prop.innerType === "StructProperty" && prop.arrayStructInfo) {
                        const info = prop.arrayStructInfo;
                        this.writeFName(info.propertyName);
                        this.writeFName(info.propertyType);
                        this.writer.writeInt32(info.size);
                        this.writeFName(info.structName);
                        this.writeGuid(info.guid);
                        this.writer.writeUInt8(info.hasGuid);
                        prop.value.forEach((item) => {
                            if (item instanceof Uint8Array) {
                                this.writer.writeBytes(item);
                            } else if (Array.isArray(item)) {
                                if (item.length === 1 && item[0] && item[0].type === "ByteProperty" && item[0].value instanceof Uint8Array) {
                                    this.writer.writeBytes(item[0].value);
                                } else {
                                    this.writeProperties(item);
                                }
                            } else {
                                const v = item;
                                const sName2 = info.structName;
                                if (sName2 === "Vector" || sName2 === "Rotator") {
                                    this.writer.writeFloat(v.x || 0);
                                    this.writer.writeFloat(v.y || 0);
                                    this.writer.writeFloat(v.z || 0);
                                } else if (sName2 === "Vector2D") {
                                    this.writer.writeFloat(v.x || 0);
                                    this.writer.writeFloat(v.y || 0);
                                } else if (sName2 === "Quat" || sName2 === "Vector4") {
                                    this.writer.writeFloat(v.x || 0);
                                    this.writer.writeFloat(v.y || 0);
                                    this.writer.writeFloat(v.z || 0);
                                    this.writer.writeFloat(v.w || 1);
                                } else if (sName2 === "Color") {
                                    this.writer.writeUInt8(v.b || 0);
                                    this.writer.writeUInt8(v.g || 0);
                                    this.writer.writeUInt8(v.r || 0);
                                    this.writer.writeUInt8(v.a || 255);
                                } else if (sName2 === "LinearColor") {
                                    this.writer.writeFloat(v.r || 0);
                                    this.writer.writeFloat(v.g || 0);
                                    this.writer.writeFloat(v.b || 0);
                                    this.writer.writeFloat(v.a || 1);
                                } else if (sName2 === "Transform") {
                                    const rot = v.rotation || { x: 0, y: 0, z: 0, w: 1 };
                                    const trans = v.translation || { x: 0, y: 0, z: 0 };
                                    const scale = v.scale3D || { x: 1, y: 1, z: 1 };
                                    this.writer.writeFloat(rot.x || 0);
                                    this.writer.writeFloat(rot.y || 0);
                                    this.writer.writeFloat(rot.z || 0);
                                    this.writer.writeFloat(rot.w || 1);
                                    this.writer.writeFloat(trans.x || 0);
                                    this.writer.writeFloat(trans.y || 0);
                                    this.writer.writeFloat(trans.z || 0);
                                    this.writer.writeFloat(scale.x || 1);
                                    this.writer.writeFloat(scale.y || 1);
                                    this.writer.writeFloat(scale.z || 1);
                                } else if (sName2 === "Guid") {
                                    if (typeof v === "string") {
                                        this.writeGuid(v);
                                    } else if (v instanceof Uint8Array && v.length === 16) {
                                        this.writer.writeBytes(v);
                                    } else {
                                        for (let i = 0; i < 16; i++)
                                            this.writer.writeUInt8(0);
                                    }
                                }
                            }
                        });
                    } else {
                        prop.value.forEach((v) => {
                            this.writeSingleValue(prop.innerType || "IntProperty", v);
                        });
                    }
                }
                break;
            case "MapProperty":
                // MapProperty: Always write raw bytes to ensure byte-perfect preservation
                if (prop.originalBytes && !prop.isModified) {
                    if (this.enableDebug) {
                        this.log(`[RAW PRESERVE] Writing original bytes for MapProperty '${prop.name}' (${prop.originalBytes.length} bytes)`);
                    }
                    this.writer.writeBytes(prop.originalBytes);
                    break;
                }

                // Handle raw map data format
                if (prop.value && typeof prop.value === 'object' && prop.value._isRawMapData) {
                    if (prop.value.rawData instanceof Uint8Array) {
                        this.writer.writeBytes(prop.value.rawData);
                        if (this.enableDebug) {
                            this.log(`  -> MapProperty (Raw): ${prop.value.rawData.length} bytes`);
                        }
                    }
                    break;
                }

                // Fallback: write value as raw bytes if it's a Uint8Array
                if (prop.value instanceof Uint8Array) {
                    this.writer.writeBytes(prop.value);
                }
                break;
            default:
                if (prop.value instanceof Uint8Array) {
                    this.writer.writeBytes(prop.value);
                }
                break;
        }
    }
};


export {
  UAssetBinaryReader,
  UAssetBinaryWriter,
  UAssetHeaderReader,
  UAssetHeaderWriter,
  UAssetNameMapReader,
  UAssetObjectReader,
  UAssetPropertyReader,
  UAssetPropertyWriter,
  __defNormalProp,
  __defProp,
  __publicField
};
