/* eslint-disable */
/**
 * ui.js — 原工具的界面逻辑（DOM 强依赖），以下划线开头的说明均为原实现。
 * 依赖 engine.js 暴露到 globalThis 的读写器类，由 scripts/build-web.mjs 拼接。
 * 与原始版本的差异：仅剔除远端门禁调用点（见 README「改动清单」）。
 */
var fileInput = document.getElementById("fileInput");
var treeRoot = document.getElementById("treeRoot");
var tableBody = document.getElementById("tableBody");
var fileInfo = document.getElementById("fileInfo");
var loadingOverlay = document.getElementById("loadingOverlay");
var saveBtn = document.getElementById("saveBtn");
var menuToggle = document.getElementById("menuToggle");
var sidebar = document.getElementById("sidebar");
var sidebarOverlay = document.getElementById("sidebarOverlay");
var globalUAssetBuffer = null;
var globalUExpBuffer = null;
var globalHeader = null;
var globalNameMap = [];
var globalImports = [];
var globalExports = [];
var modifiedProperties = new Map();
function ensureNameInMap(name) {
    debugLog(`[UPDATE] Checking name in map: ${name}`);
    let index = globalNameMap.indexOf(name);
    if (index === -1) {
        debugLog(`[UPDATE] Adding new name to map: ${name}`);
        globalNameMap.push(name);
        index = globalNameMap.length - 1;
        debugLog(`[UPDATE] New name added at index: ${index}`);
    } else {
        debugLog(`[UPDATE] Name already exists at index: ${index}`);
    }
    return index;
}
function getIconForProperty(type) {
    if (type === "ArrayProperty")
        return "\u{1F4DA}";
    if (type === "StructProperty")
        return "\u2684";
    return "\u{1F539}";
}
function renderHexDump(data, container) {
    container.innerHTML = "";
    const hexTable = document.createElement("div");
    hexTable.style.fontFamily = "'Consolas', 'Courier New', monospace";
    hexTable.style.fontSize = "12px";
    hexTable.style.lineHeight = "1.4";
    hexTable.style.whiteSpace = "pre";
    hexTable.style.color = "#d4d4d4";
    hexTable.style.padding = "10px";
    hexTable.style.backgroundColor = "#1e1e1e";
    const chunkSize = 16;
    let output = "";
    output += `<span style="color:#569cd6">Offset</span>    <span style="color:#4ec9b0">00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F</span>    <span style="color:#ce9178">Decoded Text</span>
`;
    output += `<span style="color:#444">-------------------------------------------------------------------------</span>
`;
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        output += `<span style="color:#569cd6">${i.toString(16).padStart(8, "0").toUpperCase()}</span>  `;
        let hexString = "";
        for (let j = 0; j < chunkSize; j++) {
            if (j < chunk.length) {
                hexString += `<span style="color:${chunk[j] === 0 ? "#666" : "#b5cea8"}">${chunk[j].toString(16).padStart(2, "0").toUpperCase()}</span> `;
            } else {
                hexString += "   ";
            }
        }
        output += hexString + "  ";
        let asciiString = "";
        for (let j = 0; j < chunkSize; j++) {
            if (j < chunk.length) {
                const charCode = chunk[j];
                if (charCode >= 32 && charCode <= 126) {
                    asciiString += String.fromCharCode(charCode);
                } else {
                    asciiString += ".";
                }
            }
        }
        output += `<span style="color:#ce9178">${asciiString}</span>
`;
    }
    hexTable.innerHTML = output;
    const wrapper = document.createElement("div");
    wrapper.style.overflow = "auto";
    wrapper.style.height = "100%";
    wrapper.appendChild(hexTable);
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.padding = "0";
    td.appendChild(wrapper);
    row.appendChild(td);
    container.appendChild(row);
}
function formatValue(val) {
    if (val === null || val === void 0)
        return "None";
    if (typeof val === "boolean")
        return val ? "True" : "False";
    if (val instanceof Uint8Array)
        return `Binary Data (${val.length} bytes)`;
    if (typeof val === "object") {
        if (Array.isArray(val))
            return `Array[${val.length}]`;
        if ("object" in val && "functionName" in val)
            return `Object: ${val.object}, Function: ${val.functionName}`;
        if ("assetPathName" in val && "subPathString" in val)
            return `Asset: ${val.assetPathName}, SubPath: ${val.subPathString}`;
        if ("flags" in val && "historyType" in val)
            return `FText: ${val.sourceString || "(empty)"}`;
        if ("x" in val && "y" in val && "z" in val)
            return `(X=${val.x.toFixed(3)}, Y=${val.y.toFixed(3)}, Z=${val.z.toFixed(3)})`;
        if ("x" in val && "y" in val)
            return `(X=${val.x.toFixed(3)}, Y=${val.y.toFixed(3)})`;
        if ("r" in val)
            return `(R=${val.r}, G=${val.g}, B=${val.b}, A=${val.a})`;
        return "（结构体）";
    }
    return String(val);
}
function resolvePackageIndex(index) {
    if (index === 0)
        return "None";
    if (index < 0) {
        const importIdx = -index - 1;
        if (globalImports && globalImports[importIdx]) {
            return globalImports[importIdx].objectName || `Import_${importIdx}`;
        }
        return `Import_${importIdx}`;
    } else {
        const exportIdx = index - 1;
        if (globalExports && globalExports[exportIdx]) {
            return globalExports[exportIdx].objectName || `Export_${exportIdx}`;
        }
        return `Export_${exportIdx}`;
    }
}
// History Manager for Undo/Redo functionality - Stable Immutable Action Pattern
var HistoryManager = {
    undoStack: [],
    redoStack: [],

    // Centralized function to apply a value to both the object model and UI
    applyState: function (action, valueToApply) {
        // 1. Update Internal Object Model with proper data type handling
        if (action.key === 'value') {
            // Ensure correct data type based on property type
            if (action.propertyType === 'IntProperty' || action.propertyType === 'UInt32Property') {
                action.property.value = parseInt(valueToApply) || 0;
            } else if (action.propertyType === 'FloatProperty') {
                action.property.value = parseFloat(valueToApply) || 0;
            } else if (action.propertyType === 'BoolProperty') {
                action.property.value = Boolean(valueToApply);
            } else {
                action.property.value = valueToApply;
            }
        } else if (action.key === 'rawIndex') {
            action.property.rawIndex = parseInt(valueToApply) || 0;
        } else if (action.key && typeof action.property === 'object' && action.property[action.key] !== undefined) {
            action.property[action.key] = valueToApply;
        } else if (action.key && typeof action.property.value === 'object' && action.property.value !== null) {
            action.property.value[action.key] = valueToApply;
        }

        // 2. Update UI Input Element immediately if it exists
        if (action.inputElement) {
            if (action.inputElement.type === 'checkbox') {
                action.inputElement.checked = Boolean(valueToApply);
            } else if (action.inputElement.type === 'color' || (action.inputElement.placeholder && ['R', 'G', 'B', 'A'].includes(action.inputElement.placeholder))) {
                // Handle color input - convert object to hex and update all related inputs
                if (typeof valueToApply === 'object' && valueToApply !== null) {
                    const r = Math.max(0, Math.min(1, valueToApply.r || 0));
                    const g = Math.max(0, Math.min(1, valueToApply.g || 0));
                    const b = Math.max(0, Math.min(1, valueToApply.b || 0));
                    const row = action.inputElement.closest('tr');
                    if (row) {
                        // Update color picker
                        const colorInput = row.querySelector('input[type="color"]');
                        if (colorInput) {
                            colorInput.value = `#${Math.round(r * 255).toString(16).padStart(2, "0")}${Math.round(g * 255).toString(16).padStart(2, "0")}${Math.round(b * 255).toString(16).padStart(2, "0")}`;
                        }
                        // Update R, G, B, A inputs
                        const rInput = row.querySelector('input[placeholder="R"]');
                        const gInput = row.querySelector('input[placeholder="G"]');
                        const bInput = row.querySelector('input[placeholder="B"]');
                        const aInput = row.querySelector('input[placeholder="A"]');
                        if (rInput) rInput.value = (valueToApply.r || 0).toFixed(3).replace('.', ',');
                        if (gInput) gInput.value = (valueToApply.g || 0).toFixed(3).replace('.', ',');
                        if (bInput) bInput.value = (valueToApply.b || 0).toFixed(3).replace('.', ',');
                        if (aInput) aInput.value = (valueToApply.a !== undefined ? valueToApply.a : 1).toFixed(3).replace('.', ',');
                    }
                }
            } else if (action.inputElement.type === 'number') {
                action.inputElement.value = String(valueToApply);
            } else {
                action.inputElement.value = String(valueToApply);
            }
        }

        // 3. Mark as modified
        if (typeof markAsModified === 'function' && action.property) {
            markAsModified(action.property);
        }
    },

    recordChange: function (property, key, oldValue, newValue, inputElement, propertyType) {
        // Only record if value actually changed
        if (oldValue === newValue) return;

        // 1. Check for continuous editing on the same field (debounce logic)
        const lastAction = this.undoStack[this.undoStack.length - 1];
        if (lastAction && lastAction.property === property && lastAction.key === key) {
            // Just update the final state - same editing session
            lastAction.newValue = newValue;
            lastAction.inputElement = inputElement; // Update element reference in case it changed
            lastAction.propertyType = propertyType; // Update type in case it changed
        } else {
            // New action - push to stack
            this.undoStack.push({
                property: property,
                key: key,
                oldValue: oldValue,
                newValue: newValue,
                inputElement: inputElement,
                propertyType: propertyType
            });
        }

        // 2. IMPORTANT: Clear redo stack on any new manual change
        this.redoStack = [];
        this.updateButtonStates();
    },

    undo: function () {
        if (this.undoStack.length === 0) return;

        // Pop action from undo stack
        const action = this.undoStack.pop();

        // Apply the OLD value (restore previous state)
        this.applyState(action, action.oldValue);

        // Move action to redo stack AS IS (immutable - never swap values)
        this.redoStack.push(action);
        this.updateButtonStates();
    },

    redo: function () {
        if (this.redoStack.length === 0) return;

        // Pop action from redo stack
        const action = this.redoStack.pop();

        // Apply the NEW value (restore forward state)
        this.applyState(action, action.newValue);

        // Move action back to undo stack AS IS (immutable - never swap values)
        this.undoStack.push(action);
        this.updateButtonStates();
    },

    updateButtonStates: function () {
        const undoBtn = document.getElementById("undoBtn");
        const redoBtn = document.getElementById("redoBtn");

        if (undoBtn) {
            undoBtn.disabled = this.undoStack.length === 0;
        }
        if (redoBtn) {
            redoBtn.disabled = this.redoStack.length === 0;
        }
    },

    clear: function () {
        this.undoStack = [];
        this.redoStack = [];
        this.updateButtonStates();
    }
};

function renderTable(properties, headerData, currentExport, parentArrayProperty) {
    // Exit Name Map mode and show property tools
    isNameMapView = false;
    const tableTools = document.querySelector(".table-header-tools");
    if (tableTools) tableTools.style.display = "flex";

    // Reset search placeholder for property mode
    if (propertySearch) {
        propertySearch.placeholder = "筛选此导出中的属性…";
    }

    // Restore table header for property view (5 columns)
    const thead = document.querySelector("#propertyTable thead tr");
    if (thead) {
        thead.innerHTML = `
            <th class="col-idx">#</th>
            <th class="col-name">名称</th>
            <th class="col-type">类型</th>
            <th class="col-variant">子项</th>
            <th class="col-val">数值</th>
        `;
    }

    // Save state for re-rendering when settings change
    lastRenderedProperties = properties;
    lastRenderedHeaderData = headerData;
    lastRenderedExport = currentExport;
    lastRenderedParentArray = parentArrayProperty;

    tableBody.innerHTML = "";
    if (!properties || properties.length === 0) {
        // 空表也保留「插入新属性」入口
        appendInsertPropertyRow(properties || (currentExport && currentExport.properties) || [], currentExport);
        return;
    }

    // Handle Sorting
    let sortedProperties = [...properties];
    if (currentSortOrder === "alphabetical") {
        sortedProperties.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else if (currentSortOrder === "type") {
        sortedProperties.sort((a, b) => (a.type || "").localeCompare(b.type || ""));
    }

    // Handle Filtering (Search & Modified Only)
    const query = propertySearch ? propertySearch.value.toLowerCase() : "";
    let filteredProperties = sortedProperties.filter(prop => {
        // Search Filter
        const matchesSearch = (prop.name || "").toLowerCase().includes(query) ||
            (prop.type || "").toLowerCase().includes(query);

        // Modified Only Filter
        const matchesModified = !isModifiedOnly || prop.isModified;

        return matchesSearch && matchesModified;
    });
    // Helper to recursively find parents and mark them modified
    const markAsModified = (targetProp) => {
        // 1. Mark the Export root as modified
        if (currentExport) {
            currentExport.isModified = true;
            // Visual feedback in sidebar
            const listItem = document.getElementById(`export-${globalExports.indexOf(currentExport)}`);
            if (listItem) listItem.style.color = "#4CAF50";
        }

        if (!targetProp) return;

        // 2. Mark the target property itself
        targetProp.isModified = true;
        targetProp.originalBytes = null; // Force re-write

        // 3. Find and mark all ancestors (Parent Structs/Arrays)
        if (currentExport && currentExport.properties) {

            const findAndMarkPath = (currentProps, target) => {
                for (const prop of currentProps) {
                    // If this property holds our target directly or indirectly
                    let found = false;

                    // Case A: StructProperty (Array of props)
                    if (prop.type === "StructProperty" && Array.isArray(prop.value)) {
                        if (prop.value.includes(target)) {
                            found = true;
                        } else {
                            // Recursive check inside the struct
                            found = findAndMarkPath(prop.value, target);
                        }
                    }
                    // Case B: ArrayProperty
                    else if (prop.type === "ArrayProperty" && Array.isArray(prop.value)) {
                        if (prop.value.includes(target)) {
                            found = true;
                        } else {
                            // Recursive check for Array of Structs
                            for (const item of prop.value) {
                                if (Array.isArray(item)) { // Item is a struct (array of props)
                                    if (item.includes(target)) found = true;
                                    else if (findAndMarkPath(item, target)) found = true;
                                }
                            }
                        }
                    }

                    if (found) {
                        prop.isModified = true;
                        prop.originalBytes = null; // CRITICAL: Kill raw bytes to force rebuild
                        return true; // Bubble up true to mark grandparents
                    }
                }
                return false;
            };

            // Start search from root properties
            findAndMarkPath(currentExport.properties, targetProp);
        }
    };
    filteredProperties.forEach((prop, index) => {
        const row = document.createElement("tr");
        row.setAttribute("data-type", prop.type); // For theme-based syntax highlighting
        const tdIdx = document.createElement("td");
        const tdName = document.createElement("td");
        const tdType = document.createElement("td");
        const tdVariant = document.createElement("td");
        const tdVal = document.createElement("td");
        tdIdx.className = "col-idx";
        tdName.className = "col-name";
        tdType.className = "col-type";
        tdVariant.className = "col-variant";
        tdVal.className = "col-val";
        tdVal.setAttribute("data-type", prop.type); // For CSS coloring
        const isMatParam = prop.structName && ["VectorParameterValue", "ScalarParameterValue", "TextureParameterValue"].includes(prop.structName) && Array.isArray(prop.value);
        if (prop.name === "ParameterInfo" || prop.name === "ExpressionGUID" || prop.name === "ExtraData" && isMatParam) {
            return;
        }
        if (prop.name === "ExtraData" || prop.paddingData) {
            const extraData = prop.paddingData || (prop.value instanceof Uint8Array ? prop.value : null);
            if (extraData) {
                tdIdx.textContent = String(index);
                tdName.textContent = prop.name;
                tdType.textContent = prop.type;
                tdVal.textContent = `Binary Blob (${extraData.length} bytes)`;
                tdVal.style.color = "#666";
                tdVal.style.fontStyle = "italic";
                tdVal.style.cursor = "not-allowed";
                row.style.opacity = "0.7";
                row.appendChild(tdIdx);
                row.appendChild(tdName);
                row.appendChild(tdType);
                row.appendChild(tdVariant);
                row.appendChild(tdVal);
                // Add click handler for row highlighting
                row.onclick = () => {
                    // Remove active-row class from all rows
                    const allRows = tableBody.querySelectorAll("tr");
                    allRows.forEach((r) => r.classList.remove("active-row"));
                    // Add active-row class to clicked row
                    row.classList.add("active-row");
                };
                tableBody.appendChild(row);
                return;
            }
        }
        if (isMatParam) {
            // === UAssetGUI-Style Hierarchical Material Parameter Rendering ===
            // Parent row shows: Index | Parameter Name | StructProperty | StructName | (expandable indicator)
            // Child rows show: ParameterName, ParameterValue, ExpressionGUID as separate entries

            const subProps = prop.value;

            // Find parameter name for display (from ParameterInfo.Name or direct Name property)
            const paramInfo = subProps.find((p) => p.name === "ParameterInfo");
            let displayName = prop.name; // Fallback to prop.name (usually index like "0")
            let nameProp = null;

            if (paramInfo && Array.isArray(paramInfo.value)) {
                nameProp = paramInfo.value.find((p) => p.name === "名称");
                if (nameProp && nameProp.value) {
                    displayName = String(nameProp.value);
                }
            }
            if (!nameProp) {
                nameProp = subProps.find((p) => p.name === "名称");
                if (nameProp && nameProp.value) {
                    displayName = String(nameProp.value);
                }
            }

            // Parent row setup - UAssetGUI style
            tdIdx.textContent = String(index);
            tdName.textContent = displayName;
            tdType.textContent = "StructProperty";

            // Variant column shows struct name
            const variantSpan = document.createElement("span");
            variantSpan.textContent = prop.structName || "Unknown";
            variantSpan.style.color = "#b5cea8";
            tdVariant.appendChild(variantSpan);

            // Value column shows expandable indicator
            const expandIndicator = document.createElement("span");
            expandIndicator.textContent = "▶ (3 items)";
            expandIndicator.style.color = "#888";
            expandIndicator.style.cursor = "pointer";
            expandIndicator.style.userSelect = "none";
            tdVal.appendChild(expandIndicator);

            // Track expansion state
            let isExpanded = false;
            let childRows = [];

            // Click handler to expand/collapse child properties
            row.style.cursor = "pointer";
            row.onclick = (e) => {
                // Prevent input elements from triggering expansion
                if (e.target.tagName === "INPUT") return;

                // Remove active-row class from all rows
                const allRows = tableBody.querySelectorAll("tr");
                allRows.forEach((r) => r.classList.remove("active-row"));
                row.classList.add("active-row");

                isExpanded = !isExpanded;

                if (isExpanded) {
                    expandIndicator.textContent = "▼ (3 items)";

                    // Create child rows for each sub-property
                    let childIndex = 0;

                    // === Child Row 0: ParameterName (from ParameterInfo.Name) ===
                    const nameRow = document.createElement("tr");
                    nameRow.className = "mat-param-child-row";
                    nameRow.style.backgroundColor = "rgba(255,255,255,0.03)";

                    const nameIdxTd = document.createElement("td");
                    nameIdxTd.className = "col-idx";
                    nameIdxTd.textContent = String(childIndex++);
                    nameIdxTd.style.paddingLeft = "24px";

                    const nameNameTd = document.createElement("td");
                    nameNameTd.className = "col-name";
                    nameNameTd.textContent = "ParameterName";

                    const nameTypeTd = document.createElement("td");
                    nameTypeTd.className = "col-type";
                    nameTypeTd.textContent = "NameProperty";

                    const nameVariantTd = document.createElement("td");
                    nameVariantTd.className = "col-variant";

                    const nameValTd = document.createElement("td");
                    nameValTd.className = "col-val";

                    // Find the actual Name property to edit
                    let actualNameProp = null;
                    if (paramInfo && Array.isArray(paramInfo.value)) {
                        actualNameProp = paramInfo.value.find((p) => p.name === "名称");
                    }
                    if (!actualNameProp) {
                        actualNameProp = subProps.find((p) => p.name === "名称");
                    }

                    if (actualNameProp) {
                        const nameInput = document.createElement("input");
                        nameInput.type = "text";
                        nameInput.value = String(actualNameProp.value || "");
                        nameInput.style.width = "100%";
                        let nameOldValue = actualNameProp.value;
                        nameInput.onfocus = () => { nameOldValue = actualNameProp.value; };
                        nameInput.onclick = (e) => e.stopPropagation();
                        nameInput.onblur = (e) => {
                            const newValue = e.target.value;
                            if (newValue !== nameOldValue) {
                                HistoryManager.recordChange(actualNameProp, 'value', nameOldValue, newValue, nameInput, "NameProperty");
                                actualNameProp.value = newValue;
                                markAsModified(prop);
                                // Update parent row display name
                                tdName.textContent = newValue;
                            }
                        };
                        nameValTd.appendChild(nameInput);
                    } else {
                        nameValTd.textContent = displayName;
                    }

                    nameRow.appendChild(nameIdxTd);
                    nameRow.appendChild(nameNameTd);
                    nameRow.appendChild(nameTypeTd);
                    nameRow.appendChild(nameVariantTd);
                    nameRow.appendChild(nameValTd);
                    childRows.push(nameRow);

                    // === Child Row 1: ParameterValue ===
                    const valProp = subProps.find((p) => p.name === "ParameterValue");
                    if (valProp) {
                        const valRow = document.createElement("tr");
                        valRow.className = "mat-param-child-row";
                        valRow.style.backgroundColor = "rgba(255,255,255,0.03)";

                        const valIdxTd = document.createElement("td");
                        valIdxTd.className = "col-idx";
                        valIdxTd.textContent = String(childIndex++);
                        valIdxTd.style.paddingLeft = "24px";

                        const valNameTd = document.createElement("td");
                        valNameTd.className = "col-name";
                        valNameTd.textContent = "ParameterValue";

                        const valTypeTd = document.createElement("td");
                        valTypeTd.className = "col-type";
                        valTypeTd.textContent = valProp.type || "StructProperty";

                        const valVariantTd = document.createElement("td");
                        valVariantTd.className = "col-variant";

                        const valValTd = document.createElement("td");
                        valValTd.className = "col-val";

                        // Render based on Material Parameter type
                        if (prop.structName === "VectorParameterValue" && valProp.structName === "LinearColor") {
                            // Variant shows LinearColor
                            const lcSpan = document.createElement("span");
                            lcSpan.textContent = "LinearColor";
                            lcSpan.style.color = "#b5cea8";
                            valVariantTd.appendChild(lcSpan);

                            // Value shows color picker + RGBA inputs
                            const colorValue = valProp.value || { r: 0, g: 0, b: 0, a: 1 };
                            const r = Math.max(0, Math.min(1, colorValue.r || 0));
                            const g = Math.max(0, Math.min(1, colorValue.g || 0));
                            const b = Math.max(0, Math.min(1, colorValue.b || 0));
                            const a = Math.max(0, Math.min(1, colorValue.a !== void 0 ? colorValue.a : 1));

                            const container = document.createElement("div");
                            container.style.display = "flex";
                            container.style.gap = "8px";
                            container.style.alignItems = "center";

                            const colorInput = document.createElement("input");
                            colorInput.type = "color";
                            colorInput.value = `#${Math.round(r * 255).toString(16).padStart(2, "0")}${Math.round(g * 255).toString(16).padStart(2, "0")}${Math.round(b * 255).toString(16).padStart(2, "0")}`;
                            colorInput.style.width = "40px";
                            colorInput.style.height = "24px";
                            colorInput.style.cursor = "pointer";
                            colorInput.onclick = (e) => e.stopPropagation();

                            const inputsContainer = document.createElement("div");
                            inputsContainer.style.display = "flex";
                            inputsContainer.style.gap = "4px";

                            const createColorInput = (placeholder, value) => {
                                const input = document.createElement("input");
                                input.type = "text"; // Changed to text to support comma display
                                input.placeholder = placeholder;
                                input.value = typeof value === 'number' ? value.toFixed(3).replace('.', ',') : String(value);
                                input.style.width = "60px";
                                input.style.padding = "2px 4px";
                                input.onclick = (e) => e.stopPropagation();
                                // Support typing both . and , (auto-convert . to ,)
                                input.onkeydown = (e) => {
                                    if (e.key === '.') {
                                        e.preventDefault();
                                        const start = input.selectionStart;
                                        const end = input.selectionEnd;
                                        input.value = input.value.substring(0, start) + ',' + input.value.substring(end);
                                        input.setSelectionRange(start + 1, start + 1);
                                        input.dispatchEvent(new Event('input'));
                                    }
                                };
                                return input;
                            };

                            const rInput = createColorInput("R", colorValue.r || 0);
                            const gInput = createColorInput("G", colorValue.g || 0);
                            const bInput = createColorInput("B", colorValue.b || 0);
                            const aInput = createColorInput("A", colorValue.a !== void 0 ? colorValue.a : 1);

                            let colorOldValue = { ...valProp.value };

                            const updateFromPicker = (e) => {
                                const hex = e.target.value;
                                const newR = parseInt(hex.substr(1, 2), 16) / 255;
                                const newG = parseInt(hex.substr(3, 2), 16) / 255;
                                const newB = parseInt(hex.substr(5, 2), 16) / 255;
                                const newValue = { r: newR, g: newG, b: newB, a: parseFloat(aInput.value) || 1 };
                                HistoryManager.recordChange(valProp, 'value', colorOldValue, newValue, colorInput, "StructProperty");
                                valProp.value = newValue;
                                colorOldValue = { ...newValue };
                                markAsModified(prop);
                                rInput.value = newR.toFixed(3).replace('.', ',');
                                gInput.value = newG.toFixed(3).replace('.', ',');
                                bInput.value = newB.toFixed(3).replace('.', ',');
                            };

                            const updateFromInputs = (sourceInput) => {
                                const parseVal = (v) => parseFloat(String(v).replace(',', '.')) || 0;
                                const r2 = parseVal(rInput.value);
                                const g2 = parseVal(gInput.value);
                                const b2 = parseVal(bInput.value);
                                const a2 = aInput.value !== "" ? parseVal(aInput.value) : 1;
                                const newValue = { r: r2, g: g2, b: b2, a: a2 };
                                HistoryManager.recordChange(valProp, 'value', colorOldValue, newValue, sourceInput, "StructProperty");
                                valProp.value = newValue;
                                colorOldValue = { ...newValue };
                                markAsModified(prop);
                                const rClamped = Math.max(0, Math.min(1, r2));
                                const gClamped = Math.max(0, Math.min(1, g2));
                                const bClamped = Math.max(0, Math.min(1, b2));
                                colorInput.value = `#${Math.round(rClamped * 255).toString(16).padStart(2, "0")}${Math.round(gClamped * 255).toString(16).padStart(2, "0")}${Math.round(bClamped * 255).toString(16).padStart(2, "0")}`;
                            };

                            colorInput.onfocus = () => { colorOldValue = { ...valProp.value }; };
                            colorInput.oninput = updateFromPicker;

                            [rInput, gInput, bInput, aInput].forEach((input) => {
                                input.onfocus = () => { colorOldValue = { ...valProp.value }; };
                                input.oninput = () => updateFromInputs(input);
                            });

                            inputsContainer.appendChild(rInput);
                            inputsContainer.appendChild(gInput);
                            inputsContainer.appendChild(bInput);
                            inputsContainer.appendChild(aInput);

                            container.appendChild(colorInput);
                            container.appendChild(inputsContainer);
                            valValTd.appendChild(container);

                        } else if (prop.structName === "ScalarParameterValue" && valProp.type === "FloatProperty") {
                            // Float input for scalar values
                            const input = document.createElement("input");
                            input.type = "text"; // Support comma display
                            input.value = typeof valProp.value === 'number' ? valProp.value.toFixed(3).replace('.', ',') : String(valProp.value);
                            input.style.width = "150px";
                            input.onclick = (e) => e.stopPropagation();

                            let oldVal = valProp.value;
                            input.onfocus = () => { oldVal = valProp.value; };
                            // Support typing both . and ,
                            input.onkeydown = (e) => {
                                if (e.key === '.') {
                                    e.preventDefault();
                                    const start = input.selectionStart;
                                    const end = input.selectionEnd;
                                    input.value = input.value.substring(0, start) + ',' + input.value.substring(end);
                                    input.setSelectionRange(start + 1, start + 1);
                                    input.dispatchEvent(new Event('input'));
                                }
                            };
                            input.oninput = (e) => {
                                const newVal = parseFloat(e.target.value.replace(',', '.')) || 0;
                                HistoryManager.recordChange(valProp, 'value', oldVal, newVal, input, valProp.type);
                                valProp.value = newVal;
                                markAsModified(prop);
                            };
                            valValTd.appendChild(input);

                        } else if (prop.structName === "TextureParameterValue" && valProp.type === "ObjectProperty") {
                            // Object reference for texture values
                            if (valProp.rawIndex === void 0) {
                                const parsed = parseInt(String(valProp.value));
                                valProp.rawIndex = isNaN(parsed) ? 0 : parsed;
                            }

                            const container = document.createElement("div");
                            container.style.display = "flex";
                            container.style.gap = "8px";
                            container.style.alignItems = "center";

                            const variantInput = document.createElement("input");
                            variantInput.type = "number";
                            variantInput.value = String(valProp.rawIndex);
                            variantInput.style.width = "80px";
                            variantInput.onclick = (e) => e.stopPropagation();

                            const valueDisplay = document.createElement("div");
                            valueDisplay.className = "read-only-box";
                            valueDisplay.style.padding = "2px 4px";
                            valueDisplay.style.flex = "1";

                            const updateValueDisplay = () => {
                                const resolvedName = resolvePackageIndex(valProp.rawIndex || 0);
                                valueDisplay.textContent = resolvedName;
                                valProp.value = resolvedName;
                            };
                            updateValueDisplay();

                            let variantOldValue = valProp.rawIndex;
                            variantInput.onfocus = () => { variantOldValue = valProp.rawIndex; };
                            variantInput.oninput = (e) => {
                                const inputValue = e.target.value;
                                if (inputValue === '' || inputValue === '-') return;
                                const newVariant = parseInt(inputValue);
                                if (!isNaN(newVariant)) {
                                    HistoryManager.recordChange(valProp, 'rawIndex', variantOldValue, newVariant, variantInput, "ObjectProperty");
                                    valProp.rawIndex = newVariant;
                                    updateValueDisplay();
                                    markAsModified(prop);
                                }
                            };

                            container.appendChild(variantInput);
                            container.appendChild(valueDisplay);
                            valValTd.appendChild(container);
                        } else {
                            valValTd.textContent = formatValue(valProp.value);
                        }

                        valRow.appendChild(valIdxTd);
                        valRow.appendChild(valNameTd);
                        valRow.appendChild(valTypeTd);
                        valRow.appendChild(valVariantTd);
                        valRow.appendChild(valValTd);
                        childRows.push(valRow);
                    }

                    // === Child Row 2: ExpressionGUID ===
                    const guidProp = subProps.find((p) => p.name === "ExpressionGUID");
                    if (guidProp) {
                        const guidRow = document.createElement("tr");
                        guidRow.className = "mat-param-child-row";
                        guidRow.style.backgroundColor = "rgba(255,255,255,0.03)";

                        const guidIdxTd = document.createElement("td");
                        guidIdxTd.className = "col-idx";
                        guidIdxTd.textContent = String(childIndex++);
                        guidIdxTd.style.paddingLeft = "24px";

                        const guidNameTd = document.createElement("td");
                        guidNameTd.className = "col-name";
                        guidNameTd.textContent = "ExpressionGUID";

                        const guidTypeTd = document.createElement("td");
                        guidTypeTd.className = "col-type";
                        guidTypeTd.textContent = "StructProperty";

                        const guidVariantTd = document.createElement("td");
                        guidVariantTd.className = "col-variant";
                        const guidVariantSpan = document.createElement("span");
                        guidVariantSpan.textContent = "Guid";
                        guidVariantSpan.style.color = "#b5cea8";
                        guidVariantTd.appendChild(guidVariantSpan);

                        const guidValTd = document.createElement("td");
                        guidValTd.className = "col-val";

                        // Format GUID value
                        if (guidProp.value && typeof guidProp.value === "object") {
                            const g = guidProp.value;
                            const formatHex = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
                            guidValTd.textContent = `${formatHex(g.a)}-${formatHex(g.b)}-${formatHex(g.c)}-${formatHex(g.d)}`;
                            guidValTd.style.fontFamily = "monospace";
                            guidValTd.style.color = "#888";
                        } else {
                            guidValTd.textContent = String(guidProp.value || "00000000-00000000-00000000-00000000");
                            guidValTd.style.color = "#888";
                        }

                        guidRow.appendChild(guidIdxTd);
                        guidRow.appendChild(guidNameTd);
                        guidRow.appendChild(guidTypeTd);
                        guidRow.appendChild(guidVariantTd);
                        guidRow.appendChild(guidValTd);
                        childRows.push(guidRow);
                    }

                    // Insert child rows after parent row
                    const parentIndex = Array.from(tableBody.children).indexOf(row);
                    childRows.forEach((childRow, idx) => {
                        if (parentIndex >= 0 && parentIndex + idx + 1 < tableBody.children.length) {
                            tableBody.insertBefore(childRow, tableBody.children[parentIndex + idx + 1]);
                        } else {
                            tableBody.appendChild(childRow);
                        }
                    });

                } else {
                    // Collapse: remove child rows
                    expandIndicator.textContent = "▶ (3 items)";
                    childRows.forEach((childRow) => {
                        if (childRow.parentNode) {
                            childRow.parentNode.removeChild(childRow);
                        }
                    });
                    childRows = [];
                }
            };

        } else {
            tdIdx.textContent = String(index);
            tdName.textContent = prop.name;
            tdType.textContent = prop.type;
            if (prop.type === "ObjectProperty") {
                if (prop.rawIndex === void 0) {
                    const parsed = parseInt(String(prop.value));
                    prop.rawIndex = isNaN(parsed) ? 0 : parsed;
                }
                const variantInput = document.createElement("input");
                variantInput.type = "number";
                variantInput.value = String(prop.rawIndex);
                const valueDisplay = document.createElement("div");
                valueDisplay.className = "read-only-box";
                valueDisplay.style.width = "100%";
                valueDisplay.style.padding = "2px 4px";
                valueDisplay.style.minHeight = "20px";
                valueDisplay.style.display = "flex";
                valueDisplay.style.alignItems = "center";
                valueDisplay.style.cursor = "not-allowed";
                valueDisplay.style.opacity = "0.7";
                const updateValueDisplay = () => {
                    const resolvedName = resolvePackageIndex(prop.rawIndex || 0);
                    valueDisplay.textContent = resolvedName;
                    prop.value = resolvedName;
                };
                updateValueDisplay();
                let variantOldValue2 = prop.rawIndex;
                variantInput.onfocus = () => {
                    variantOldValue2 = prop.rawIndex;
                };
                variantInput.oninput = (e) => {
                    const inputValue = e.target.value;
                    if (inputValue === '' || inputValue === '-') {
                        HistoryManager.updateButtonStates();
                        return;
                    }
                    const newVariant = parseInt(inputValue);
                    if (!isNaN(newVariant)) {
                        HistoryManager.recordChange(prop, 'rawIndex', variantOldValue2, newVariant, variantInput, prop.type);
                        prop.rawIndex = newVariant;
                        updateValueDisplay();
                        markAsModified(prop);
                    }
                };
                tdVariant.appendChild(variantInput);
                tdVal.appendChild(valueDisplay);
            } else if (prop.type === "DelegateProperty" || prop.type === "MulticastDelegateProperty") {
                if (typeof prop.value === "object" && prop.value !== null && prop.value.object !== void 0) {
                    if (prop.rawIndex === void 0) {
                        const parsed = parseInt(String(prop.value.object));
                        prop.rawIndex = isNaN(parsed) ? 0 : parsed;
                    }
                    const objectInput = document.createElement("input");
                    objectInput.type = "number";
                    objectInput.value = String(prop.rawIndex);
                    objectInput.style.width = "80px";
                    objectInput.style.marginRight = "4px";
                    const objectDisplay = document.createElement("div");
                    objectDisplay.className = "read-only-box";
                    objectDisplay.style.width = "calc(100% - 90px)";
                    objectDisplay.style.padding = "2px 4px";
                    objectDisplay.style.minHeight = "20px";
                    objectDisplay.style.display = "inline-block";
                    objectDisplay.style.cursor = "not-allowed";
                    objectDisplay.style.opacity = "0.7";
                    const functionInput = document.createElement("input");
                    functionInput.type = "text";
                    functionInput.value = prop.value.functionName || "None";
                    functionInput.style.width = "100%";
                    functionInput.style.marginTop = "4px";
                    const updateObjectDisplay = () => {
                        const resolvedName = resolvePackageIndex(prop.rawIndex || 0);
                        objectDisplay.textContent = resolvedName;
                        if (prop.value) {
                            prop.value.object = resolvedName;
                        }
                    };
                    updateObjectDisplay();
                    let objectOldValue = prop.rawIndex;
                    objectInput.onfocus = () => {
                        objectOldValue = prop.rawIndex;
                    };
                    objectInput.oninput = (e) => {
                        const inputValue = e.target.value;
                        if (inputValue === '' || inputValue === '-') {
                            HistoryManager.updateButtonStates();
                            return;
                        }
                        const newVariant = parseInt(inputValue);
                        if (!isNaN(newVariant)) {
                            HistoryManager.recordChange(prop, 'rawIndex', objectOldValue, newVariant, objectInput, prop.type);
                            prop.rawIndex = newVariant;
                            updateObjectDisplay();
                            markAsModified(prop);
                        }
                    };
                    let functionOldValue = prop.value ? prop.value.functionName : "None";
                    functionInput.onfocus = () => {
                        functionOldValue = prop.value ? prop.value.functionName : "None";
                    };
                    functionInput.oninput = (e) => {
                        if (prop.value) {
                            const newFunctionName = e.target.value || "None";
                            HistoryManager.recordChange(prop.value, 'functionName', functionOldValue, newFunctionName, functionInput, prop.type);
                            prop.value.functionName = newFunctionName;
                            markAsModified(prop);
                        }
                    };
                    const wrapper = document.createElement("div");
                    wrapper.style.display = "flex";
                    wrapper.style.flexDirection = "column";
                    wrapper.style.gap = "4px";
                    const objectWrapper = document.createElement("div");
                    objectWrapper.style.display = "flex";
                    objectWrapper.style.alignItems = "center";
                    objectWrapper.appendChild(objectInput);
                    objectWrapper.appendChild(objectDisplay);
                    wrapper.appendChild(objectWrapper);
                    wrapper.appendChild(functionInput);
                    tdVal.appendChild(wrapper);
                } else {
                    tdVal.textContent = formatValue(prop.value);
                }
            } else if (prop.type === "ArrayProperty") {
                const variantSpan = document.createElement("span");
                variantSpan.textContent = prop.innerType || "Unknown";
                variantSpan.style.color = "#b5cea8";
                tdVariant.appendChild(variantSpan);
                tdVal.textContent = `Array [${Array.isArray(prop.value) ? prop.value.length : 0}]`;
                tdVal.style.color = "#666";
            } else if (prop.type === "StructProperty" || ["Vector", "Rotator", "Color", "Vector2D", "LinearColor", "Quat", "Vector4", "IntPoint", "Box", "Box2D"].includes(prop.type)) {
                // Handle both StructProperty and native struct types from tree view
                const effectiveStructName = prop.structName || prop.type;
                const isMaterialParameterStruct = effectiveStructName && ["VectorParameterValue", "ScalarParameterValue", "TextureParameterValue", "MaterialParameterInfo"].includes(effectiveStructName);
                if (!isMaterialParameterStruct) {
                    const variantSpan = document.createElement("span");
                    variantSpan.textContent = effectiveStructName || "Unknown";
                    variantSpan.style.color = "#b5cea8";
                    tdVariant.appendChild(variantSpan);
                }
                // Check for WaveParameter by name OR by content (if it has Amplitude/Wavelength properties)
                if ((effectiveStructName === "WaveParameter" || (Array.isArray(prop.value) &&
                    prop.value.some(p => p.name.includes("Amplitude")) &&
                    prop.value.some(p => p.name.includes("Wavelength")))) &&
                    Array.isArray(prop.value)) {

                    const structValue = prop.value;
                    const container = document.createElement("div");
                    container.style.display = "flex";
                    container.style.gap = "4px";
                    container.style.flexWrap = "wrap";

                    const fields = ["Amplitude", "Wavelength", "Speed", "Offset"];

                    fields.forEach(field => {
                        // Find property handling partial matches (e.g. "GlobalWaveAmplitude" matches "Amplitude")
                        const targetProp = structValue.find(p => p.name.includes(field));

                        const input = document.createElement("input");
                        input.type = "number";
                        input.step = "0.001";
                        input.placeholder = field.substr(0, 3);
                        input.title = targetProp ? targetProp.name : field;
                        // If property exists, use its value, otherwise 0
                        input.value = String(targetProp ? targetProp.value : 0);
                        input.style.width = "70px";
                        input.style.padding = "2px 4px";

                        if (!targetProp) {
                            input.disabled = true;
                            input.title = `${field} property not found in struct`;
                            input.style.opacity = "0.5";
                        } else {
                            let oldValue = targetProp.value;
                            input.onfocus = () => { oldValue = targetProp.value; };
                            input.oninput = () => {
                                const newVal = parseFloat(input.value) || 0;
                                HistoryManager.recordChange(targetProp, 'value', oldValue, newVal, input, targetProp.type);
                                targetProp.value = newVal;
                                markAsModified(prop);
                            };
                        }
                        container.appendChild(input);
                    });
                    tdVal.appendChild(container);
                }
                // AttrModifyItem & AttrDynamicModifier Support (Aggressive Detection)
                // Check struct name OR check for signature properties (ModifierValue + AttrName)
                else if ((["AttrModifyItem", "AttrDynamicModifier"].includes(effectiveStructName) ||
                    (Array.isArray(prop.value) && prop.value.some(p => p.name === "ModifierValue")))
                    && Array.isArray(prop.value)) {

                    const structValue = prop.value;
                    const container = document.createElement("div");
                    container.style.display = "flex";
                    container.style.alignItems = "center";
                    container.style.gap = "6px";
                    container.style.flexWrap = "wrap";

                    // 1. AttrName / AttrModifyItemName (String/Name)
                    const nameProp = structValue.find(p => p.name === "AttrName" || p.name === "AttrModifyItemName");
                    if (nameProp) {
                        const nameInput = document.createElement("input");
                        nameInput.type = "text";
                        nameInput.value = String(nameProp.value);
                        nameInput.placeholder = "名称";
                        nameInput.style.width = "120px";
                        nameInput.title = nameProp.name;
                        nameInput.style.border = "1px solid #555";

                        let oldNameVal = nameProp.value;
                        nameInput.onfocus = () => { oldNameVal = nameProp.value; };
                        nameInput.oninput = (e) => {
                            const newVal = e.target.value;
                            HistoryManager.recordChange(nameProp, 'value', oldNameVal, newVal, nameInput, nameProp.type);
                            nameProp.value = newVal;
                            markAsModified(prop);
                        };
                        container.appendChild(nameInput);
                    }

                    // 2. ModifierOp (Enum)
                    const opProp = structValue.find(p => p.name === "ModifierOp");
                    if (opProp) {
                        const opSpan = document.createElement("span");
                        let opText = String(opProp.value).split("::").pop();
                        opSpan.textContent = opText;
                        opSpan.style.fontSize = "10px";
                        opSpan.style.color = "#aaa";
                        opSpan.style.border = "1px solid #444";
                        opSpan.style.padding = "2px 4px";
                        opSpan.style.borderRadius = "3px";
                        opSpan.title = String(opProp.value);
                        container.appendChild(opSpan);
                    }

                    // 3. ModifierValue (Float)
                    const valProp = structValue.find(p => p.name === "ModifierValue");
                    if (valProp) {
                        const valInput = document.createElement("input");
                        valInput.type = "number";
                        valInput.step = "0.0001"; // Finer step
                        valInput.value = String(valProp.value);
                        valInput.placeholder = "Val";
                        valInput.style.width = "80px";

                        let oldVal = valProp.value;
                        valInput.onfocus = () => { oldVal = valProp.value; };
                        valInput.oninput = (e) => {
                            const newVal = parseFloat(e.target.value) || 0;
                            HistoryManager.recordChange(valProp, 'value', oldVal, newVal, valInput, valProp.type);
                            valProp.value = newVal;
                            markAsModified(prop);
                        };
                        container.appendChild(valInput);
                    }

                    // 4. IsEnable / ClientSimulate (Bool)
                    const boolProps = structValue.filter(p => p.type === "BoolProperty");
                    boolProps.forEach(bProp => {
                        const lbl = document.createElement("label");
                        lbl.style.display = "flex";
                        lbl.style.alignItems = "center";
                        lbl.style.fontSize = "10px";
                        lbl.style.gap = "2px";
                        lbl.style.cursor = "pointer";
                        lbl.style.color = "#ccc";

                        const check = document.createElement("input");
                        check.type = "checkbox";
                        check.checked = bProp.value === true;

                        let oldBool = bProp.value;
                        check.onfocus = () => { oldBool = bProp.value; };
                        check.oninput = (e) => {
                            const newVal = e.target.checked;
                            HistoryManager.recordChange(bProp, 'value', oldBool, newVal, check, bProp.type);
                            bProp.value = newVal;
                            markAsModified(prop);
                        };

                        let labelText = bProp.name === "IsEnable" ? "On" : (bProp.name === "ClientSimulate" ? "Sim" : bProp.name);

                        lbl.appendChild(check);
                        lbl.appendChild(document.createTextNode(labelText));
                        container.appendChild(lbl);
                    });

                    tdVal.appendChild(container);
                }
                else if (["Vector", "Rotator", "Color", "Vector2D", "LinearColor", "Quat", "Vector4", "IntPoint", "Guid", "Box", "Box2D"].includes(effectiveStructName || "")) {
                    const structName = effectiveStructName || "";
                    const structValue = prop.value || {};

                    // LinearColor: Color picker + 4 float inputs (R, G, B, A) - range 0-1
                    if (structName === "LinearColor") {
                        const container = document.createElement("div");
                        container.style.display = "flex";
                        container.style.flexDirection = "column";
                        container.style.gap = "4px";

                        const colorInput = document.createElement("input");
                        colorInput.type = "color";
                        const r = Math.max(0, Math.min(1, structValue.r || 0));
                        const g = Math.max(0, Math.min(1, structValue.g || 0));
                        const b = Math.max(0, Math.min(1, structValue.b || 0));
                        colorInput.value = `#${Math.round(r * 255).toString(16).padStart(2, "0")}${Math.round(g * 255).toString(16).padStart(2, "0")}${Math.round(b * 255).toString(16).padStart(2, "0")}`;
                        colorInput.style.width = "100%";
                        colorInput.style.height = "24px";
                        colorInput.style.cursor = "pointer";

                        const inputsContainer = document.createElement("div");
                        inputsContainer.style.display = "flex";
                        inputsContainer.style.gap = "4px";
                        inputsContainer.style.alignItems = "center";

                        const createLinearInput = (placeholder, initialValue) => {
                            const input = document.createElement("input");
                            input.type = "text"; // Support comma display
                            input.placeholder = placeholder;
                            input.value = typeof initialValue === 'number' ? initialValue.toFixed(3).replace('.', ',') : String(initialValue);
                            input.style.width = "60px";
                            input.style.padding = "2px 4px";
                            // Support typing both . and , (auto-convert . to ,)
                            input.onkeydown = (e) => {
                                if (e.key === '.') {
                                    e.preventDefault();
                                    const start = input.selectionStart;
                                    const end = input.selectionEnd;
                                    input.value = input.value.substring(0, start) + ',' + input.value.substring(end);
                                    input.setSelectionRange(start + 1, start + 1);
                                    input.dispatchEvent(new Event('input'));
                                }
                            };
                            return input;
                        };

                        const rInput = createLinearInput("R", r);
                        const gInput = createLinearInput("G", g);
                        const bInput = createLinearInput("B", b);
                        const aInput = createLinearInput("A", structValue.a !== void 0 ? structValue.a : 1);

                        let colorOldValue = { ...structValue };

                        colorInput.onfocus = () => {
                            colorOldValue = { ...structValue };
                        };

                        colorInput.oninput = (e) => {
                            const hex = e.target.value;
                            const newR = parseInt(hex.substring(1, 3), 16) / 255;
                            const newG = parseInt(hex.substring(3, 5), 16) / 255;
                            const newB = parseInt(hex.substring(5, 7), 16) / 255;
                            const newValue = { r: newR, g: newG, b: newB, a: structValue.a !== void 0 ? structValue.a : 1 };
                            HistoryManager.recordChange(prop, 'value', colorOldValue, newValue, colorInput, prop.type);
                            prop.value = newValue;
                            markAsModified(prop);
                            rInput.value = newR.toFixed(3).replace('.', ',');
                            gInput.value = newG.toFixed(3).replace('.', ',');
                            bInput.value = newB.toFixed(3).replace('.', ',');
                        };

                        const updateColorFromInputs = (sourceInput) => {
                            const parseVal = (v) => parseFloat(String(v).replace(',', '.')) || 0;
                            const r2 = parseVal(rInput.value);
                            const g2 = parseVal(gInput.value);
                            const b2 = parseVal(bInput.value);
                            const a2 = aInput.value !== "" ? parseVal(aInput.value) : 1;
                            const newValue = { r: r2, g: g2, b: b2, a: a2 };
                            HistoryManager.recordChange(prop, 'value', colorOldValue, newValue, sourceInput, prop.type);
                            prop.value = newValue;
                            colorOldValue = { ...newValue };
                            markAsModified(prop);
                            const rClamped = Math.max(0, Math.min(1, r2));
                            const gClamped = Math.max(0, Math.min(1, g2));
                            const bClamped = Math.max(0, Math.min(1, b2));
                            colorInput.value = `#${Math.round(rClamped * 255).toString(16).padStart(2, "0")}${Math.round(gClamped * 255).toString(16).padStart(2, "0")}${Math.round(bClamped * 255).toString(16).padStart(2, "0")}`;
                        };

                        [rInput, gInput, bInput, aInput].forEach((input) => {
                            input.onfocus = () => {
                                colorOldValue = { ...structValue };
                            };
                            input.oninput = () => updateColorFromInputs(input);
                        });

                        container.appendChild(colorInput);
                        inputsContainer.appendChild(rInput);
                        inputsContainer.appendChild(gInput);
                        inputsContainer.appendChild(bInput);
                        inputsContainer.appendChild(aInput);
                        container.appendChild(inputsContainer);
                        tdVal.appendChild(container);
                    }
                    // Color (Byte): Color picker + 4 integer inputs (R, G, B, A) - range 0-255
                    else if (structName === "Color") {
                        const container = document.createElement("div");
                        container.style.display = "flex";
                        container.style.flexDirection = "column";
                        container.style.gap = "4px";

                        const colorInput = document.createElement("input");
                        colorInput.type = "color";
                        const r = Math.max(0, Math.min(255, structValue.r || 0));
                        const g = Math.max(0, Math.min(255, structValue.g || 0));
                        const b = Math.max(0, Math.min(255, structValue.b || 0));
                        colorInput.value = `#${Math.round(r).toString(16).padStart(2, "0")}${Math.round(g).toString(16).padStart(2, "0")}${Math.round(b).toString(16).padStart(2, "0")}`;
                        colorInput.style.width = "100%";
                        colorInput.style.height = "24px";
                        colorInput.style.cursor = "pointer";

                        const inputsContainer = document.createElement("div");
                        inputsContainer.style.display = "flex";
                        inputsContainer.style.gap = "4px";
                        inputsContainer.style.alignItems = "center";

                        const rInput = document.createElement("input");
                        rInput.type = "number";
                        rInput.step = "1";
                        rInput.min = "0";
                        rInput.max = "255";
                        rInput.placeholder = "R";
                        rInput.value = String(r);
                        rInput.style.width = "60px";
                        rInput.style.padding = "2px 4px";

                        const gInput = document.createElement("input");
                        gInput.type = "number";
                        gInput.step = "1";
                        gInput.min = "0";
                        gInput.max = "255";
                        gInput.placeholder = "G";
                        gInput.value = String(g);
                        gInput.style.width = "60px";
                        gInput.style.padding = "2px 4px";

                        const bInput = document.createElement("input");
                        bInput.type = "number";
                        bInput.step = "1";
                        bInput.min = "0";
                        bInput.max = "255";
                        bInput.placeholder = "B";
                        bInput.value = String(b);
                        bInput.style.width = "60px";
                        bInput.style.padding = "2px 4px";

                        const aInput = document.createElement("input");
                        aInput.type = "number";
                        aInput.step = "1";
                        aInput.min = "0";
                        aInput.max = "255";
                        aInput.placeholder = "A";
                        aInput.value = String(structValue.a !== void 0 ? structValue.a : 255);
                        aInput.style.width = "60px";
                        aInput.style.padding = "2px 4px";

                        let colorOldValue = { ...structValue };

                        colorInput.onfocus = () => {
                            colorOldValue = { ...structValue };
                        };

                        colorInput.oninput = (e) => {
                            const hex = e.target.value;
                            const newR = parseInt(hex.substring(1, 3), 16);
                            const newG = parseInt(hex.substring(3, 5), 16);
                            const newB = parseInt(hex.substring(5, 7), 16);
                            const newValue = { r: newR, g: newG, b: newB, a: structValue.a !== void 0 ? structValue.a : 255 };
                            HistoryManager.recordChange(prop, 'value', colorOldValue, newValue, colorInput, prop.type);
                            prop.value = newValue;
                            markAsModified(prop);
                            rInput.value = String(newR);
                            gInput.value = String(newG);
                            bInput.value = String(newB);
                        };

                        const updateColorFromInputs = (sourceInput) => {
                            const r2 = parseInt(rInput.value) || 0;
                            const g2 = parseInt(gInput.value) || 0;
                            const b2 = parseInt(bInput.value) || 0;
                            const a2 = parseInt(aInput.value) !== void 0 ? parseInt(aInput.value) : 255;
                            const newValue = { r: r2, g: g2, b: b2, a: a2 };
                            HistoryManager.recordChange(prop, 'value', colorOldValue, newValue, sourceInput, prop.type);
                            prop.value = newValue;
                            colorOldValue = { ...newValue };
                            markAsModified(prop);
                            const rClamped = Math.max(0, Math.min(255, r2));
                            const gClamped = Math.max(0, Math.min(255, g2));
                            const bClamped = Math.max(0, Math.min(255, b2));
                            colorInput.value = `#${Math.round(rClamped).toString(16).padStart(2, "0")}${Math.round(gClamped).toString(16).padStart(2, "0")}${Math.round(bClamped).toString(16).padStart(2, "0")}`;
                        };

                        [rInput, gInput, bInput, aInput].forEach((input) => {
                            input.onfocus = () => {
                                colorOldValue = { ...structValue };
                            };
                            input.oninput = () => updateColorFromInputs(input);
                        });

                        container.appendChild(colorInput);
                        inputsContainer.appendChild(rInput);
                        inputsContainer.appendChild(gInput);
                        inputsContainer.appendChild(bInput);
                        inputsContainer.appendChild(aInput);
                        container.appendChild(inputsContainer);
                        tdVal.appendChild(container);
                    }
                    // Vector / Rotator: 3 number inputs (X, Y, Z)
                    else if (structName === "Vector" || structName === "Rotator") {
                        const inputsContainer = document.createElement("div");
                        inputsContainer.style.display = "flex";
                        inputsContainer.style.gap = "4px";
                        inputsContainer.style.alignItems = "center";

                        const xInput = document.createElement("input");
                        xInput.type = "number";
                        xInput.step = "0.000001";
                        xInput.placeholder = "X";
                        xInput.value = String(structValue.x !== void 0 ? structValue.x : 0);
                        xInput.style.width = "80px";
                        xInput.style.padding = "2px 4px";

                        const yInput = document.createElement("input");
                        yInput.type = "number";
                        yInput.step = "0.000001";
                        yInput.placeholder = "Y";
                        yInput.value = String(structValue.y !== void 0 ? structValue.y : 0);
                        yInput.style.width = "80px";
                        yInput.style.padding = "2px 4px";

                        const zInput = document.createElement("input");
                        zInput.type = "number";
                        zInput.step = "0.000001";
                        zInput.placeholder = "Z";
                        zInput.value = String(structValue.z !== void 0 ? structValue.z : 0);
                        zInput.style.width = "80px";
                        zInput.style.padding = "2px 4px";

                        let vectorOldValue = { ...structValue };

                        const updateVector = (sourceInput) => {
                            const x2 = parseFloat(xInput.value) || 0;
                            const y2 = parseFloat(yInput.value) || 0;
                            const z2 = parseFloat(zInput.value) || 0;
                            const newValue = { x: x2, y: y2, z: z2 };
                            HistoryManager.recordChange(prop, 'value', vectorOldValue, newValue, sourceInput, prop.type);
                            prop.value = newValue;
                            vectorOldValue = { ...newValue };
                            markAsModified(prop);
                        };

                        [xInput, yInput, zInput].forEach((input) => {
                            input.onfocus = () => {
                                vectorOldValue = { ...structValue };
                            };
                            input.oninput = () => updateVector(input);
                        });

                        inputsContainer.appendChild(xInput);
                        inputsContainer.appendChild(yInput);
                        inputsContainer.appendChild(zInput);
                        tdVal.appendChild(inputsContainer);
                    }
                    // Vector2D: 2 number inputs (X, Y)
                    else if (structName === "Vector2D") {
                        const inputsContainer = document.createElement("div");
                        inputsContainer.style.display = "flex";
                        inputsContainer.style.gap = "4px";
                        inputsContainer.style.alignItems = "center";

                        const xInput = document.createElement("input");
                        xInput.type = "number";
                        xInput.step = "0.000001";
                        xInput.placeholder = "X";
                        xInput.value = String(structValue.x !== void 0 ? structValue.x : 0);
                        xInput.style.width = "80px";
                        xInput.style.padding = "2px 4px";

                        const yInput = document.createElement("input");
                        yInput.type = "number";
                        yInput.step = "0.000001";
                        yInput.placeholder = "Y";
                        yInput.value = String(structValue.y !== void 0 ? structValue.y : 0);
                        yInput.style.width = "80px";
                        yInput.style.padding = "2px 4px";

                        let vectorOldValue = { ...structValue };

                        const updateVector = (sourceInput) => {
                            const x2 = parseFloat(xInput.value) || 0;
                            const y2 = parseFloat(yInput.value) || 0;
                            const newValue = { x: x2, y: y2 };
                            HistoryManager.recordChange(prop, 'value', vectorOldValue, newValue, sourceInput, prop.type);
                            prop.value = newValue;
                            vectorOldValue = { ...newValue };
                            markAsModified(prop);
                        };

                        [xInput, yInput].forEach((input) => {
                            input.onfocus = () => {
                                vectorOldValue = { ...structValue };
                            };
                            input.oninput = () => updateVector(input);
                        });

                        inputsContainer.appendChild(xInput);
                        inputsContainer.appendChild(yInput);
                        tdVal.appendChild(inputsContainer);
                    }
                    // Quat / Vector4: 4 number inputs (X, Y, Z, W)
                    else if (structName === "Quat" || structName === "Vector4") {
                        const inputsContainer = document.createElement("div");
                        inputsContainer.style.display = "flex";
                        inputsContainer.style.gap = "4px";
                        inputsContainer.style.alignItems = "center";

                        const xInput = document.createElement("input");
                        xInput.type = "number";
                        xInput.step = "0.000001";
                        xInput.placeholder = "X";
                        xInput.value = String(structValue.x !== void 0 ? structValue.x : 0);
                        xInput.style.width = "70px";
                        xInput.style.padding = "2px 4px";

                        const yInput = document.createElement("input");
                        yInput.type = "number";
                        yInput.step = "0.000001";
                        yInput.placeholder = "Y";
                        yInput.value = String(structValue.y !== void 0 ? structValue.y : 0);
                        yInput.style.width = "70px";
                        yInput.style.padding = "2px 4px";

                        const zInput = document.createElement("input");
                        zInput.type = "number";
                        zInput.step = "0.000001";
                        zInput.placeholder = "Z";
                        zInput.value = String(structValue.z !== void 0 ? structValue.z : 0);
                        zInput.style.width = "70px";
                        zInput.style.padding = "2px 4px";

                        const wInput = document.createElement("input");
                        wInput.type = "number";
                        wInput.step = "0.000001";
                        wInput.placeholder = "W";
                        wInput.value = String(structValue.w !== void 0 ? structValue.w : 0);
                        wInput.style.width = "70px";
                        wInput.style.padding = "2px 4px";

                        let vectorOldValue = { ...structValue };

                        const updateVector = (sourceInput) => {
                            const x2 = parseFloat(xInput.value) || 0;
                            const y2 = parseFloat(yInput.value) || 0;
                            const z2 = parseFloat(zInput.value) || 0;
                            const w2 = parseFloat(wInput.value) || 0;
                            const newValue = { x: x2, y: y2, z: z2, w: w2 };
                            HistoryManager.recordChange(prop, 'value', vectorOldValue, newValue, sourceInput, prop.type);
                            prop.value = newValue;
                            vectorOldValue = { ...newValue };
                            markAsModified(prop);
                        };

                        [xInput, yInput, zInput, wInput].forEach((input) => {
                            input.onfocus = () => {
                                vectorOldValue = { ...structValue };
                            };
                            input.oninput = () => updateVector(input);
                        });

                        inputsContainer.appendChild(xInput);
                        inputsContainer.appendChild(yInput);
                        inputsContainer.appendChild(zInput);
                        inputsContainer.appendChild(wInput);
                        tdVal.appendChild(inputsContainer);
                    }
                    // IntPoint: 2 integer inputs (X, Y)
                    else if (structName === "IntPoint") {
                        const inputsContainer = document.createElement("div");
                        inputsContainer.style.display = "flex";
                        inputsContainer.style.gap = "4px";
                        inputsContainer.style.alignItems = "center";

                        const xInput = document.createElement("input");
                        xInput.type = "number";
                        xInput.step = "1";
                        xInput.placeholder = "X";
                        xInput.value = String(structValue.x !== void 0 ? structValue.x : 0);
                        xInput.style.width = "80px";
                        xInput.style.padding = "2px 4px";

                        const yInput = document.createElement("input");
                        yInput.type = "number";
                        yInput.step = "1";
                        yInput.placeholder = "Y";
                        yInput.value = String(structValue.y !== void 0 ? structValue.y : 0);
                        yInput.style.width = "80px";
                        yInput.style.padding = "2px 4px";

                        let pointOldValue = { ...structValue };

                        const updatePoint = (sourceInput) => {
                            const x2 = parseInt(xInput.value) || 0;
                            const y2 = parseInt(yInput.value) || 0;
                            const newValue = { x: x2, y: y2 };
                            HistoryManager.recordChange(prop, 'value', pointOldValue, newValue, sourceInput, prop.type);
                            prop.value = newValue;
                            pointOldValue = { ...newValue };
                            markAsModified(prop);
                        };

                        [xInput, yInput].forEach((input) => {
                            input.onfocus = () => {
                                pointOldValue = { ...structValue };
                            };
                            input.oninput = () => updatePoint(input);
                        });

                        inputsContainer.appendChild(xInput);
                        inputsContainer.appendChild(yInput);
                        tdVal.appendChild(inputsContainer);
                    }
                    // Box: Render summary display
                    else if (structName === "Box") {
                        const min = structValue.min || { x: 0, y: 0, z: 0 };
                        const max = structValue.max || { x: 0, y: 0, z: 0 };
                        tdVal.textContent = `Min(${min.x.toFixed(1)},${min.y.toFixed(1)},${min.z.toFixed(1)}) Max(${max.x.toFixed(1)},${max.y.toFixed(1)},${max.z.toFixed(1)})`;
                        tdVal.style.fontSize = "11px";
                    }
                    // Box2D: Render summary display
                    else if (structName === "Box2D") {
                        const min = structValue.min || { x: 0, y: 0 };
                        const max = structValue.max || { x: 0, y: 0 };
                        tdVal.textContent = `Min(${min.x.toFixed(1)},${min.y.toFixed(1)}) Max(${max.x.toFixed(1)},${max.y.toFixed(1)})`;
                        tdVal.style.fontSize = "11px";
                    }
                    // Guid: Keep as read-only for now
                    else if (structName === "Guid") {
                        tdVal.textContent = formatValue(prop.value);
                    }
                } else {
                    tdVal.textContent = prop.structName ? `（${prop.structName}）➦ 点开` : `（结构体）➦ 点开`;
                    tdVal.style.color = "#666";
                    tdVal.title = "复杂结构，请在左侧树状视图中查看";
                }
            } else {
                if (prop.type === "BoolProperty") {
                    const input = document.createElement("input");
                    input.type = "checkbox";
                    input.checked = prop.value === true;
                    let oldValue = prop.value;
                    input.onfocus = () => {
                        oldValue = prop.value;
                    };
                    input.oninput = (e) => {
                        const newValue = e.target.checked;
                        HistoryManager.recordChange(prop, 'value', oldValue, newValue, input, prop.type);
                        prop.value = newValue;
                        markAsModified(prop);
                    };
                    tdVal.appendChild(input);
                } else if (["IntProperty", "FloatProperty", "UInt32Property"].includes(prop.type)) {
                    const input = document.createElement("input");
                    input.type = "number";
                    input.value = String(prop.value);
                    if (prop.type === "FloatProperty")
                        input.step = "0.000001";
                    let oldValue = prop.value;
                    input.onfocus = () => {
                        oldValue = prop.value;
                    };
                    input.oninput = (e) => {
                        const inputValue = e.target.value;
                        // Handle empty input or invalid values
                        if (inputValue === '' || inputValue === '-') {
                            HistoryManager.updateButtonStates();
                            return;
                        }
                        const newValue = prop.type === "IntProperty" || prop.type === "UInt32Property"
                            ? parseInt(inputValue)
                            : parseFloat(inputValue);
                        if (!isNaN(newValue)) {
                            HistoryManager.recordChange(prop, 'value', oldValue, newValue, input, prop.type);
                            prop.value = newValue;
                            markAsModified(prop);
                        }
                    };
                    tdVal.appendChild(input);
                } else if (["StrProperty", "NameProperty"].includes(prop.type)) {
                    const input = document.createElement("input");
                    input.type = "text";
                    input.value = String(prop.value);
                    let oldValue = prop.value;
                    input.onfocus = () => {
                        oldValue = prop.value;
                    };
                    if (prop.type === "NameProperty") {
                        // For NameProperty, use onblur to avoid updating on every keystroke
                        // This prevents adding multiple entries to the name map during typing
                        input.onblur = (e) => {
                            const newValue = e.target.value;
                            if (newValue !== oldValue) {
                                HistoryManager.recordChange(prop, 'value', oldValue, newValue, input, prop.type);
                                prop.value = newValue;

                                // If this is an array element, update the parent array's value array
                                if (prop.arrayIndex !== void 0 && parentArrayProperty && Array.isArray(parentArrayProperty.value)) {
                                    parentArrayProperty.value[prop.arrayIndex] = newValue;
                                    markAsModified(parentArrayProperty);
                                    debugLog(`[UPDATE] Updated parent ArrayProperty '${parentArrayProperty.name}' at index ${prop.arrayIndex}`);
                                }

                                markAsModified(prop);
                                debugLog(`[UPDATE] Editing ${prop.type} '${prop.name}': '${oldValue}' -> '${newValue}'`);
                                const nameIndex = ensureNameInMap(newValue);
                                debugLog(`[UPDATE] NameProperty '${prop.name}' updated to '${newValue}' (index: ${nameIndex})`);
                            }
                        };
                    } else {
                        // For StrProperty, keep oninput for real-time updates
                        input.oninput = (e) => {
                            const newValue = e.target.value;
                            HistoryManager.recordChange(prop, 'value', oldValue, newValue, input, prop.type);
                            prop.value = newValue;

                            // If this is an array element, update the parent array's value array
                            if (prop.arrayIndex !== void 0 && parentArrayProperty && Array.isArray(parentArrayProperty.value)) {
                                parentArrayProperty.value[prop.arrayIndex] = newValue;
                                markAsModified(parentArrayProperty);
                            }

                            markAsModified(prop);
                            debugLog(`[UPDATE] StrProperty '${prop.name}' updated to '${newValue}'`);
                        };
                    }
                    tdVal.appendChild(input);
                } else if (prop.type === "EnumProperty") {
                    // Display enum name in variant column
                    if (prop.enumName) {
                        const enumSpan = document.createElement("span");
                        enumSpan.textContent = prop.enumName;
                        enumSpan.style.color = "#b5cea8";
                        tdVariant.appendChild(enumSpan);
                    }
                    // Display full enum value in value column
                    const enumValue = String(prop.value);
                    tdVal.textContent = enumValue;
                    tdVal.style.color = "#fff";
                } else if (prop.type === "MapProperty") {
                    tdVal.textContent = `Map`;
                    tdVal.style.color = "#666";
                } else {
                    tdVal.textContent = formatValue(prop.value);
                }
            }
        }
        row.appendChild(tdIdx);
        row.appendChild(tdName);
        row.appendChild(tdType);
        row.appendChild(tdVariant);
        row.appendChild(tdVal);
        // Add click handler for row highlighting
        row.onclick = () => {
            // Remove active-row class from all rows
            const allRows = tableBody.querySelectorAll("tr");
            allRows.forEach((r) => r.classList.remove("active-row"));
            // Add active-row class to clicked row
            row.classList.add("active-row");
        };
        row.__dfProp = prop;
        tableBody.appendChild(row);
    });

    // === 插入新属性：固定在最后一行 ===
    appendInsertPropertyRow(properties, currentExport);
    dfDecorateRows(properties, currentExport);
}
function createTreeNode(label, icon, onClick, parentList, hasChildren = true) {
    const li = document.createElement("li");
    const contentDiv = document.createElement("div");
    contentDiv.className = "node-content";
    const toggleBox = document.createElement("span");
    toggleBox.className = "toggle-box";
    toggleBox.textContent = "+";
    if (!hasChildren) {
        toggleBox.classList.add("empty");
    }
    contentDiv.appendChild(toggleBox);
    const iconSpan = document.createElement("span");
    iconSpan.className = "node-icon";
    iconSpan.textContent = icon;
    contentDiv.appendChild(iconSpan);
    const textSpan = document.createElement("span");
    textSpan.textContent = label;
    contentDiv.appendChild(textSpan);
    li.appendChild(contentDiv);
    const ul = document.createElement("ul");
    ul.className = "nested-group";
    li.appendChild(ul);
    contentDiv.onclick = () => {
        document.querySelectorAll(".node-content").forEach((el) => el.classList.remove("selected"));
        contentDiv.classList.add("selected");
        onClick(false); // Full selection (will close sidebar)
    };
    // Store silent expansion method for Expand All feature
    contentDiv.expandSilent = () => {
        if (ul.children.length === 0) {
            onClick(true);
        }
    };
    toggleBox.onclick = (e) => {
        e.stopPropagation();
        if (!toggleBox.classList.contains("empty")) {
            const isVisible = ul.classList.toggle("show");
            toggleBox.textContent = isVisible ? "-" : "+";
            // If opening, trigger onClick with true to load data WITHOUT closing sidebar
            if (isVisible) {
                onClick(true); // Expansion only
            }
        }
    };
    contentDiv.ondblclick = () => {
        if (!toggleBox.classList.contains("empty")) {
            const isVisible = ul.classList.toggle("show");
            toggleBox.textContent = isVisible ? "-" : "+";
            if (isVisible) {
                onClick(true); // Expansion only
            }
        }
    };
    parentList.appendChild(li);
    return ul;
}
function processPropertiesToTree(properties, parentUl, currentExport) {
    // Native struct types that should be shown in tree (like UAssetGUI)
    const nativeStructTypes = ["Vector", "Rotator", "Color", "Vector2D", "LinearColor", "Quat", "Vector4", "IntPoint", "Box", "Box2D"];

    const complexProps = properties.filter(
        (p) => ["StructProperty", "ArrayProperty", "MapProperty"].includes(p.type)
    );
    if (complexProps.length > 0) {
        const parentLi = parentUl.parentElement;
        const toggle = parentLi?.querySelector(".toggle-box");
        if (toggle)
            toggle.classList.remove("empty");
    }
    complexProps.forEach((prop) => {
        let label = prop.name;
        let icon = getIconForProperty(prop.type);
        const isNativeStruct = nativeStructTypes.includes(prop.structName || "");

        if (prop.type === "ArrayProperty") {
            label += ` (${prop.value.length})`;
        } else if (prop.type === "StructProperty" && isNativeStruct) {
            // Native structs like Vector/Rotator show as "(1)" like UAssetGUI
            label += ` (1)`;
        }

        // Native structs are leaf nodes (no children to expand)
        const hasChildren = !isNativeStruct;

        const subUl = createTreeNode(label, icon, () => {
            if (prop.type === "StructProperty" && isNativeStruct) {
                // Wrap native struct in a synthetic property for table display
                const syntheticProp = [{
                    name: prop.structName,
                    type: prop.structName,
                    structName: prop.structName,
                    value: prop.value,
                    size: prop.size || 0,
                    arrayIndex: 0,
                    // Keep reference to original prop for editing
                    _originalProp: prop
                }];
                renderTable(syntheticProp, void 0, currentExport);
            } else if (prop.type === "StructProperty" && Array.isArray(prop.value)) {
                renderTable(prop.value, void 0, currentExport);
                if (subUl.children.length === 0) {
                    processPropertiesToTree(prop.value, subUl, currentExport);
                }
            } else if (prop.type === "ArrayProperty" && Array.isArray(prop.value)) {
                const materialParameterArrayNames = ["ScalarParameterValues", "VectorParameterValues", "TextureParameterValues"];
                const isMaterialParameterArrayByName = materialParameterArrayNames.includes(prop.name);
                const isMaterialParameterArrayByStruct = prop.arrayStructInfo && ["VectorParameterValue", "ScalarParameterValue", "TextureParameterValue"].includes(prop.arrayStructInfo.structName);
                const isMaterialParameterArray = isMaterialParameterArrayByName || isMaterialParameterArrayByStruct;
                if (isMaterialParameterArray && prop.value.length > 0 && Array.isArray(prop.value[0])) {
                    const arrayTableData = prop.value.map((item, idx) => {
                        let paramName = item.find((p) => p.name === "名称");
                        if (!paramName) {
                            const paramInfo = item.find((p) => p.name === "ParameterInfo");
                            if (paramInfo && Array.isArray(paramInfo.value)) {
                                paramName = paramInfo.value.find((p) => p.name === "名称");
                            }
                        }
                        const paramValue = item.find((p) => p.name === "ParameterValue");
                        const syntheticProp = {
                            name: paramName ? String(paramName.value) : `${idx}`,
                            type: "StructProperty",
                            structName: prop.arrayStructInfo?.structName || "MaterialParameter",
                            value: item,

                            size: 0,
                            arrayIndex: idx,
                            innerType: prop.innerType,
                            arrayStructInfo: prop.arrayStructInfo
                        };
                        syntheticProp.paramValuePreview = paramValue;
                        return syntheticProp;
                    });
                    renderTable(arrayTableData, void 0, currentExport, prop);
                } else {
                    const arrayTableData = prop.value.map((item, idx) => {
                        if (Array.isArray(item)) {
                            return { name: `${idx}`, type: "StructProperty", structName: prop.arrayStructInfo?.structName || prop.structName, value: item, size: 0, arrayIndex: idx };
                        } else {
                            return { name: `${idx}`, type: prop.innerType || "Unknown", value: item, size: 0, arrayIndex: idx };
                        }
                    });
                    renderTable(arrayTableData, void 0, currentExport, prop);
                }
                if (subUl.children.length === 0) {
                    prop.value.forEach((item, idx) => {
                        if (Array.isArray(item)) {
                            let nodeLabel = `${idx}`;
                            const isMaterialParameterArrayByName2 = materialParameterArrayNames.includes(prop.name);
                            const isMaterialParameterArrayByStruct2 = prop.arrayStructInfo && ["VectorParameterValue", "ScalarParameterValue", "TextureParameterValue"].includes(prop.arrayStructInfo.structName);
                            const isMaterialParameterArray2 = isMaterialParameterArrayByName2 || isMaterialParameterArrayByStruct2;
                            if (isMaterialParameterArray2) {
                                const paramInfo = item.find((p) => p.name === "ParameterInfo");
                                let nameProp;
                                if (paramInfo) {
                                    if (Array.isArray(paramInfo.value)) {
                                        nameProp = paramInfo.value.find((p) => p.name === "名称");
                                        if (nameProp && nameProp.value) {
                                            nodeLabel = String(nameProp.value);
                                        }
                                    }
                                }
                                if (nodeLabel === `${idx}`) {
                                    nameProp = item.find((p) => p.name === "名称");
                                    if (nameProp && nameProp.value) {
                                        nodeLabel = String(nameProp.value);
                                    }
                                }
                            }
                            // Default: Use parent array name + property count if still just index
                            if (nodeLabel === `${idx}`) {
                                nodeLabel = `${prop.name}`;
                                if (item.length > 0) {
                                    nodeLabel += ` (${item.length})`;
                                }
                            }
                            const itemUl = createTreeNode(nodeLabel, "\u2684", () => {
                                renderTable(item, void 0, currentExport);
                                if (itemUl.children.length === 0)
                                    processPropertiesToTree(item, itemUl, currentExport);
                            }, subUl);
                        }
                    });
                }
            } else if (prop.type === "MapProperty" && Array.isArray(prop.value)) {
                const mapTableData = prop.value.map((item, idx) => {
                    return {
                        name: String(item.key),
                        type: prop.valueType || "Unknown",
                        value: item.value,
                        size: 0,
                        arrayIndex: idx
                    };
                });
                renderTable(mapTableData);
            }
        }, parentUl, hasChildren);
    });
}
function addVirtualNodes(exp, reader, parentUl) {
    const parentLi = parentUl.parentElement;
    const toggle = parentLi?.querySelector(".toggle-box");
    if (reader) {
        const currentOffset = reader.getOffset();
        const expEnd = exp.serialOffset + exp.serialSize;
        const remainingBytes = expEnd - currentOffset;
        if (remainingBytes > 0) {
            if (toggle)
                toggle.classList.remove("empty");
            createTreeNode(`Extra Data (${remainingBytes} bytes)`, "\u{1F4BE}", () => {
                let bufferToRead = globalUAssetBuffer;
                let readStart = currentOffset;
                if (globalHeader && currentOffset >= globalHeader.totalHeaderSize && globalUExpBuffer) {
                    bufferToRead = globalUExpBuffer;
                    readStart = currentOffset - globalHeader.totalHeaderSize;
                }
                if (bufferToRead) {
                    const data = new Uint8Array(bufferToRead, readStart, remainingBytes);
                    renderHexDump(data, tableBody);
                }
            }, parentUl, false);
        }
    }
    if (!reader && exp.serialSize > 0) {
        if (toggle)
            toggle.classList.remove("empty");
        createTreeNode(`Binary Data (${exp.serialSize} bytes)`, "\u{1F4DC}", () => {
            let bufferToRead = globalUAssetBuffer;
            let readStart = exp.serialOffset;
            if (globalHeader && exp.serialOffset >= globalHeader.totalHeaderSize && globalUExpBuffer) {
                bufferToRead = globalUExpBuffer;
                readStart = exp.serialOffset - globalHeader.totalHeaderSize;
            }
            if (bufferToRead) {
                const data = new Uint8Array(bufferToRead, readStart, exp.serialSize);
                renderHexDump(data, tableBody);
            }
        }, parentUl, false);
    }
}
async function processFiles(files) {
    loadingOverlay.style.display = "flex";
    treeRoot.innerHTML = "";
    tableBody.innerHTML = "";

    let uassetFile = null;
    let uexpFile = null;

    // Scan files to find .uasset and .uexp
    for (let i = 0; i < files.length; i++) {
        const name = files[i].name.toLowerCase();
        if (name.endsWith(".uasset"))
            uassetFile = files[i];
        else if (name.endsWith(".uexp"))
            uexpFile = files[i];
    }

    // Strict Validation Rule 1: Missing .uasset file
    if (!uassetFile) {
        showToast("缺少 .uasset 文件");
        loadingOverlay.style.display = "none";
        return;
    }

    // Strict Validation Rule 2: Missing .uexp file (required even if .uasset exists)
    if (!uexpFile) {
        showToast("缺少 .uexp 文件，两个都要选");
        loadingOverlay.style.display = "none";
        return;
    }

    // Strict Validation Rule 3: Name mismatch check
    const uassetBaseName = uassetFile.name.replace(/\.uasset$/i, "");
    const uexpBaseName = uexpFile.name.replace(/\.uexp$/i, "");
    if (uassetBaseName !== uexpBaseName) {
        showToast("文件名不一致：两个文件必须同名");
        loadingOverlay.style.display = "none";
        return;
    }

    // Strict Validation Rule 4: Success - Both files exist and names match, proceed with loading
    fileInfo.textContent = uassetFile.name;

    // Reset Name Map modification tracking
    nameMapModified = false;
    nameMapNeedsGrow = false;
    originalNameMap = null;
    originalNameMapLengths = null;
    debugLog(`[PROCESS_FILES] Name Map tracking reset for new file`);

    try {
        globalUAssetBuffer = await uassetFile.arrayBuffer();
        globalUExpBuffer = await uexpFile.arrayBuffer();
        const headerReader = new UAssetHeaderReader(globalUAssetBuffer);
        globalHeader = headerReader.read();
        const nameMapReader = new UAssetNameMapReader(globalUAssetBuffer, globalHeader.fileVersionUE4);
        const endOffset = globalHeader.importOffset > 0 ? globalHeader.importOffset : globalHeader.exportOffset;
        globalNameMap = nameMapReader.read(globalHeader.nameOffset, globalHeader.nameCount, endOffset);

        // Save original Name Map immediately for rebuild size calculations
        originalNameMap = [...globalNameMap];
        originalNameMapLengths = globalNameMap.map(name => name.length);
        debugLog(`[PROCESS_FILES] Original Name Map stored (${originalNameMap.length} entries) with lengths`);

        const objectReader = new UAssetObjectReader(globalUAssetBuffer, globalNameMap, globalHeader.fileVersionUE4);
        if (globalHeader.importCount > 0) {
            objectReader.setOffset(globalHeader.importOffset);
            globalImports = objectReader.readImports(globalHeader.importCount);
        }
        if (globalHeader.exportCount > 0) {
            objectReader.setOffset(globalHeader.exportOffset);
            globalExports = objectReader.readExports(globalHeader.exportCount);
        }

        // 登记到 App 内 MCP，AI 可以直接操作这份资产
        try {
            if (window.__APP_MCP && window.__APP_MCP.register) {
                const sid = window.__APP_MCP.register(uassetFile.name, globalUAssetBuffer, globalUExpBuffer);
                if (sid) debugLog(`[MCP] 资产已登记为 ${sid}`);
            }
        } catch (e) { console.warn('[MCP] 登记失败', e); }

        // Add Name Map node at the top (before exports)
        const nameMapLi = document.createElement("li");
        nameMapLi.className = "namemap-node";
        const nameMapContent = document.createElement("div");
        nameMapContent.className = "node-content";

        // Empty toggle box (hidden via CSS)
        const toggleBox = document.createElement("span");
        toggleBox.className = "toggle-box empty";
        nameMapContent.appendChild(toggleBox);

        // Label with count (no icon, plain text)
        const textSpan = document.createElement("span");
        textSpan.textContent = `名称表 (${globalNameMap.length})`;
        nameMapContent.appendChild(textSpan);

        nameMapLi.appendChild(nameMapContent);
        treeRoot.appendChild(nameMapLi);

        // Name Map click handler
        nameMapContent.onclick = () => {
            // Select this node
            document.querySelectorAll(".node-content").forEach(el => el.classList.remove("selected"));
            nameMapContent.classList.add("selected");

            // Auto-close sidebar on mobile
            if (sidebar && sidebarOverlay) {
                sidebar.classList.remove("open");
                sidebarOverlay.classList.remove("show");
            }

            // Clear search when switching to Name Map
            if (propertySearch) propertySearch.value = "";

            // Render Name Map in the main content area
            renderNameMapTable();
        };

        globalExports.forEach((exp, index) => {
            const label = `${exp.objectName} (${index + 1})`;
            const subUl = createTreeNode(label, "\u{1F4C4}", (isExpansionOnly = false) => {
                // Auto-close sidebar ONLY IF it's a full click (not expansion only)
                if (!isExpansionOnly && sidebar && sidebarOverlay) {
                    sidebar.classList.remove("open");
                    sidebarOverlay.classList.remove("show");
                }

                // Clear search when switching between exports
                if (!isExpansionOnly && propertySearch) {
                    propertySearch.value = "";
                }
                let reader = null;
                let properties = [];
                if (exp.serialSize > 0) {
                    try {
                        if (exp.properties) {
                            properties = exp.properties;
                        } else {
                            if (!globalHeader) {
                                throw new Error("Header not loaded");
                            }
                            reader = new UAssetPropertyReader(
                                globalUAssetBuffer,
                                globalNameMap,
                                globalImports,
                                globalExports,
                                globalHeader.totalHeaderSize,
                                globalUExpBuffer || void 0,
                                isDebugEnabled()
                            );
                            reader.setOffset(exp.serialOffset);
                            properties = reader.readProperties();
                if (globalHeader && globalHeader.isDeltaForce && properties.length > 0 && properties[0].name === "RowStruct") {
                    try {
                        const dt = reader.readDataTableRows();
                        if (dt && dt.rows.length > 0) {
                            exp.dtInfo = dt;
                            for (const row of dt.rows) {
                                properties.push({
                                    name: row.name, type: "StructProperty", structType: "RowData",
                                    size: 0, arrayIndex: 0, value: row.props, __row: true
                                });
                            }
                        }
                    } catch (e) {
                        debugWarn("DataTable rows failed", e);
                    }
                }
                            const currentPos = reader.getOffset();
                            const endPos = exp.serialOffset + exp.serialSize;
                            const remainingBytes = endPos - currentPos;
                            if (remainingBytes > 0) {
                                let bufferToRead = globalUAssetBuffer;
                                let readStart = currentPos;
                                if (globalHeader && currentPos >= globalHeader.totalHeaderSize && globalUExpBuffer) {
                                    bufferToRead = globalUExpBuffer;
                                    readStart = currentPos - globalHeader.totalHeaderSize;
                                }
                                exp.extraData = new Uint8Array(bufferToRead.slice(readStart, readStart + remainingBytes));
                                debugLog(`Export ${index}: ${remainingBytes} bytes extra data saved.`);
                            } else {
                                exp.extraData = null;
                            }
                            exp.properties = properties;
                        }
                    } catch (e) {
                        debugError("Error reading export properties", e);
                    }
                }
                let propsToRender = properties;
                if (modifiedProperties.has(index)) {
                    propsToRender = modifiedProperties.get(index);
                }
                renderTable(propsToRender, {
                    Name: exp.objectName,
                    ClassIndex: exp.classIndex,
                    SerialSize: exp.serialSize
                }, exp);
                if (subUl.children.length === 0) {
                    if (propsToRender.length > 0)
                        processPropertiesToTree(propsToRender, subUl, exp);
                    if (reader)
                        addVirtualNodes(exp, reader, subUl);
                }
            }, treeRoot, false);
            if (exp.serialSize > 0) {
                const toggle = subUl.parentElement?.querySelector(".toggle-box");
                if (toggle)
                    toggle.classList.remove("empty");
            }
        });
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.style.opacity = "1";
            saveBtn.style.cursor = "pointer";
        }
        // Add file-loaded class to body to reveal hidden UI elements
        document.body.classList.add("file-loaded");
    } catch (error) {
        debugError("Error processing files", error);
        showToast("载入文件失败，请检查控制台");
    } finally {
        loadingOverlay.style.display = "none";
        // Auto-open sidebar after files are loaded
        if (sidebar && sidebarOverlay) {
            sidebar.classList.add("open");
            sidebarOverlay.classList.add("show");
        }
    }
}
var openBtn = document.getElementById("openBtn");
if (openBtn) {
    openBtn.addEventListener("click", () => {
        fileInput.click();
    });
}
if (fileInput) {
    fileInput.addEventListener("change", () => {
        if (fileInput.files) {
            // Clear history when loading new files
            HistoryManager.clear();
            processFiles(fileInput.files);
        }
    });
}

// Menu toggle functionality
if (menuToggle && sidebar && sidebarOverlay) {
    menuToggle.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        sidebarOverlay.classList.toggle("show");
    });

    sidebarOverlay.addEventListener("click", () => {
        sidebar.classList.remove("open");
        sidebarOverlay.classList.remove("show");
    });
}

// ============================================
// NAME MAP DISPLAY FUNCTIONALITY
// ============================================
var isNameMapView = false; // Flag to track if we're viewing Name Map
var selectedNameMapIndex = -1; // Currently selected name index
var nameMapModified = false; // Flag to track if Name Map has been modified
var originalNameMap = null; // Store original Name Map for comparison
var originalNameMapLengths = null; // Store original Name Map lengths for maxlength enforcement

// Render Name Map as a table in the main content area (right side)
function renderNameMapTable(searchQuery = "") {
    debugLog(`[NAME_MAP] renderNameMapTable() called with searchQuery: "${searchQuery}"`);

    if (!tableBody || !globalNameMap || globalNameMap.length === 0) {
        debugWarn(`[NAME_MAP] Cannot render - tableBody: ${!!tableBody}, globalNameMap length: ${globalNameMap?.length || 0}`);
        if (tableBody) {
            tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:40px;">No names loaded.</td></tr>';
        }
        return;
    }

    // Store original Name Map on first render (for change detection)
    if (!originalNameMap) {
        originalNameMap = [...globalNameMap];
        originalNameMapLengths = globalNameMap.map(name => name.length);
        debugLog(`[NAME_MAP] Original Name Map stored (${originalNameMap.length} entries) with lengths`);
    }

    debugLog(`[NAME_MAP] Starting render of ${globalNameMap.length} names`);
    const renderStartTime = performance.now();

    // Set flag and show search tools
    isNameMapView = true;
    debugLog(`[NAME_MAP] isNameMapView set to true`);

    const tableTools = document.querySelector(".table-header-tools");
    if (tableTools) {
        tableTools.style.display = "flex";
        debugLog(`[NAME_MAP] Search tools displayed`);
    }

    // Update placeholder text for Name Map search
    if (propertySearch) {
        propertySearch.placeholder = "筛选名称表…";
    }

    // Update table header for Name Map (Length instead of Value)
    const thead = document.querySelector("#propertyTable thead tr");
    if (thead) {
        thead.innerHTML = `
            <th class="col-idx">#</th>
            <th class="col-name">名称</th>
            <th class="col-type">类型</th>
            <th class="col-variant">子项</th>
            <th class="col-val">Length</th>
        `;
        debugLog(`[NAME_MAP] Table header ready with Length column`);
    }

    // Clear and render Name Map
    tableBody.innerHTML = "";
    const query = searchQuery.toLowerCase();
    let displayCount = 0;

    globalNameMap.forEach((name, index) => {
        // Filter by search query
        if (query && !name.toLowerCase().includes(query) && !index.toString().includes(query)) {
            return;
        }

        displayCount++;
        const row = document.createElement("tr");
        row.className = "namemap-row";
        row.dataset.nameIndex = index;

        // Check if this name was modified
        const wasModified = originalNameMap && originalNameMap[index] !== name;
        if (wasModified) {
            row.style.backgroundColor = "rgba(76, 175, 80, 0.15)";
        }

        // Index column
        const tdIdx = document.createElement("td");
        tdIdx.className = "col-idx";
        tdIdx.textContent = index;

        // Name column - EDITABLE INPUT
        const tdName = document.createElement("td");
        tdName.className = "col-name";

        // Get original length for this entry (maxlength enforcement)
        const originalLength = originalNameMapLengths ? originalNameMapLengths[index] : name.length;

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = name;
        // 不限制长度
        nameInput.className = "namemap-edit-input";
        nameInput.dataset.originalLength = originalLength;
        nameInput.style.cssText = `
            width: 100%;
            background: transparent;
            border: 1px solid transparent;
            color: var(--syntax-name);
            font-family: 'Consolas', monospace;
            font-size: 1em;
            padding: 2px 4px;
            box-sizing: border-box;
        `;

        // Live character counter element
        const charCounter = document.createElement("span");
        charCounter.className = "char-counter";
        charCounter.style.cssText = `
            font-size: 1em;
            font-family: 'Consolas', monospace;
            color: var(--syntax-float);
            display: inline-block;
            text-align: left;
        `;
        charCounter.textContent = String(name.length);

        // Update counter color based on usage
        const updateCounterColor = () => {
            charCounter.style.color = "#4caf50";
            charCounter.textContent = String(nameInput.value.length);
        };

        // Live update on input
        nameInput.oninput = () => {
            updateCounterColor();
        };

        // Focus styling
        nameInput.onfocus = () => {
            nameInput.style.border = "1px solid var(--selection)";
            nameInput.style.background = "var(--bg-dark)";
            debugLog(`[NAME_MAP_EDIT] Focus on name at index ${index}: "${name}"`);
        };

        // Blur - save changes
        nameInput.onblur = () => {
            nameInput.style.border = "1px solid transparent";
            nameInput.style.background = "transparent";

            const newName = nameInput.value;
            const oldName = globalNameMap[index];

            if (newName !== oldName) {
                debugLog(`[NAME_MAP_EDIT] ========================================`);
                debugLog(`[NAME_MAP_EDIT] NAME CHANGE DETECTED`);
                debugLog(`[NAME_MAP_EDIT] Index: ${index}`);
                debugLog(`[NAME_MAP_EDIT] Old Name: "${oldName}" (${oldName.length} chars)`);
                debugLog(`[NAME_MAP_EDIT] New Name: "${newName}" (${newName.length} chars)`);
                debugLog(`[NAME_MAP_EDIT] Length Delta: ${newName.length - oldName.length} chars`);

                // Calculate byte size difference (UTF-8)
                const oldBytes = new TextEncoder().encode(oldName).length;
                const newBytes = new TextEncoder().encode(newName).length;
                debugLog(`[NAME_MAP_EDIT] Old Bytes: ${oldBytes}`);
                debugLog(`[NAME_MAP_EDIT] New Bytes: ${newBytes}`);
                debugLog(`[NAME_MAP_EDIT] Byte Delta: ${newBytes - oldBytes}`);

                // Update globalNameMap
                globalNameMap[index] = newName;
                nameMapModified = true;
                if (newBytes !== oldBytes) { nameMapNeedsGrow = true; }

                debugLog(`[NAME_MAP_EDIT] globalNameMap[${index}] updated to: "${globalNameMap[index]}"`);
                debugLog(`[NAME_MAP_EDIT] nameMapModified = true`);
                debugLog(`[NAME_MAP_EDIT] ========================================`);

                // Visual feedback - mark row as modified
                row.style.backgroundColor = "rgba(76, 175, 80, 0.15)";

                if (charCounter) {
                    updateCounterColor();
                }
            }
        };

        // Enter key to confirm
        nameInput.onkeydown = (e) => {
            if (e.key === "Enter") {
                nameInput.blur();
            } else if (e.key === "Escape") {
                nameInput.value = globalNameMap[index];
                nameInput.blur();
            }
        };

        tdName.appendChild(nameInput);

        // Type column - show "String" for all
        const tdType = document.createElement("td");
        tdType.className = "col-type";
        tdType.innerHTML = `<span style="color: var(--syntax-type);">String</span>`;

        // Variant column - show "True" (Case Preserving)
        const tdVariant = document.createElement("td");
        tdVariant.className = "col-variant";
        tdVariant.innerHTML = `<span style="color: var(--syntax-variant);">True</span>`;

        // Length column - show character count (includes special chars like /)
        const tdLength = document.createElement("td");
        tdLength.className = "col-val";
        tdLength.appendChild(charCounter);

        row.appendChild(tdIdx);
        row.appendChild(tdName);
        row.appendChild(tdType);
        row.appendChild(tdVariant);
        row.appendChild(tdLength);

        // Row click - highlight row (but don't interfere with input)
        row.onclick = (e) => {
            // Don't trigger if clicking on input
            if (e.target.tagName === "INPUT") return;

            debugLog(`[NAME_MAP] Row clicked - Name: "${globalNameMap[index]}" (Index: ${index}, Length: ${globalNameMap[index].length})`);

            // Visual feedback
            const allRows = tableBody.querySelectorAll("tr.namemap-row");
            allRows.forEach(r => r.classList.remove("active-row"));
            row.classList.add("active-row");

            selectedNameMapIndex = index;
        };

        tableBody.appendChild(row);
    });

    // Show count if filtering
    if (query && displayCount < globalNameMap.length) {
        debugLog(`[NAME_MAP] Filtering active: showing ${displayCount} of ${globalNameMap.length} names`);
    }

    // Show modified count
    if (nameMapModified && originalNameMap) {
        let modifiedCount = 0;
        for (let i = 0; i < globalNameMap.length; i++) {
            if (globalNameMap[i] !== originalNameMap[i]) modifiedCount++;
        }
        if (modifiedCount > 0) {
            debugLog(`[NAME_MAP] ${modifiedCount} names have been modified`);
        }
    }

    const renderEndTime = performance.now();
    debugLog(`[NAME_MAP] Render completed in ${(renderEndTime - renderStartTime).toFixed(2)}ms, displayed ${displayCount} rows`);
}


// Settings functionality - UPGRADED
var settingsToggle = document.getElementById("settingsToggle");
var settingsClose = document.getElementById("settingsClose");
var settingsOverlay = document.getElementById("settingsOverlay");
var themePresetSelect = document.getElementById("themePreset");
var fontPresetSelect = document.getElementById("fontPreset");
var typeColorToggle = document.getElementById("typeColorToggle");
var hideIconsToggle = document.getElementById("hideIconsToggle");
var animToggle = document.getElementById("animToggle");
var compactModeToggle = document.getElementById("compactModeToggle");
var modifiedOnlyToggle = document.getElementById("modifiedOnlyToggle");
var sortOrderSelect = document.getElementById("sortOrder");
var zoomValue = document.getElementById("zoomValue");
var zoomMinus = document.getElementById("zoomMinus");
var zoomPlus = document.getElementById("zoomPlus");
var aboutDevBtn = document.getElementById("aboutDevBtn");
var hexEditorBtn = document.getElementById("hexEditorBtn");
var aboutOverlay = document.getElementById("aboutOverlay");
var aboutClose = document.getElementById("aboutClose");
var sidebarSearch = document.getElementById("sidebarSearch");
var propertySearch = document.getElementById("propertySearch");
var expandAllBtn = document.getElementById("expandAll");
var collapseAllBtn = document.getElementById("collapseAll");

// Global states for table rendering
var lastRenderedProperties = null;
var lastRenderedHeaderData = null;
var lastRenderedExport = null;
var lastRenderedParentArray = null;

// Initialize settings from localStorage
var currentTheme = (localStorage.getItem("theme") || "light");
var isHideIcons = localStorage.getItem("hideIcons") === "true";
var isAnimEnabled = localStorage.getItem("animations") !== "false";
var currentZoom = parseInt(localStorage.getItem("zoomLevel") || "0", 10);
var currentSortOrder = localStorage.getItem("sortOrder") || "original";
var isCompactMode = localStorage.getItem("compactMode") === "true";
var isModifiedOnly = localStorage.getItem("modifiedOnly") === "true";

// Apply saved settings on load
function applyTheme(theme) {
    document.body.classList.remove("light-theme");
    if (theme === "light") {
        document.body.classList.add("light-theme");
    }
    if (themePresetSelect) themePresetSelect.value = theme;
}

applyTheme(currentTheme);
document.body.classList.toggle("compact-mode", isCompactMode);
document.body.classList.toggle("hide-icons", isHideIcons);
document.body.classList.toggle("no-animations", !isAnimEnabled);

if (compactModeToggle) compactModeToggle.checked = isCompactMode;
if (modifiedOnlyToggle) modifiedOnlyToggle.checked = isModifiedOnly;
if (hideIconsToggle) hideIconsToggle.checked = isHideIcons;
if (animToggle) animToggle.checked = isAnimEnabled;
if (sortOrderSelect) sortOrderSelect.value = currentSortOrder;
updateZoom(currentZoom);

// Settings modal toggle
if (settingsToggle && settingsOverlay) {
    settingsToggle.addEventListener("click", () => {
        document.body.classList.add("manual-settings");
        settingsOverlay.classList.toggle("show");
    });

    const closeSettings = () => {
        document.body.classList.remove("manual-settings");
        settingsOverlay.classList.remove("show");
    };

    if (settingsClose) settingsClose.addEventListener("click", closeSettings);
    settingsOverlay.addEventListener("click", (e) => {
        if (e.target === settingsOverlay) closeSettings();
    });
}

// Theme Preset Change
if (themePresetSelect) {
    themePresetSelect.addEventListener("change", () => {
        currentTheme = themePresetSelect.value;
        applyTheme(currentTheme);
        localStorage.setItem("theme", currentTheme);
    });
}

// Interface Toggles
if (hideIconsToggle) {
    hideIconsToggle.addEventListener("change", () => {
        isHideIcons = hideIconsToggle.checked;
        document.body.classList.toggle("hide-icons", isHideIcons);
        localStorage.setItem("hideIcons", isHideIcons);
    });
}

if (animToggle) {
    animToggle.addEventListener("change", () => {
        isAnimEnabled = animToggle.checked;
        document.body.classList.toggle("no-animations", !isAnimEnabled);
        localStorage.setItem("animations", isAnimEnabled);
    });
}

// Compact Mode toggle
if (compactModeToggle) {
    compactModeToggle.addEventListener("change", () => {
        isCompactMode = compactModeToggle.checked;
        document.body.classList.toggle("compact-mode", isCompactMode);
        localStorage.setItem("compactMode", isCompactMode);
    });
}

// Modified Only toggle
if (modifiedOnlyToggle) {
    modifiedOnlyToggle.addEventListener("change", () => {
        isModifiedOnly = modifiedOnlyToggle.checked;
        localStorage.setItem("modifiedOnly", isModifiedOnly);
        if (lastRenderedProperties) {
            renderTable(lastRenderedProperties, lastRenderedHeaderData, lastRenderedExport, lastRenderedParentArray);
        }
    });
}

// Sidebar Search
if (sidebarSearch) {
    sidebarSearch.addEventListener("input", () => {
        const query = sidebarSearch.value.toLowerCase();
        const nodes = document.querySelectorAll("#treeRoot > li");
        nodes.forEach(node => {
            const text = node.textContent.toLowerCase();
            node.style.display = text.includes(query) ? "" : "none";
        });
    });
}

// Property Search (also handles Name Map search)
if (propertySearch) {
    propertySearch.addEventListener("input", () => {
        // Check if we're in Name Map view mode
        if (isNameMapView) {
            renderNameMapTable(propertySearch.value);
        } else if (lastRenderedProperties) {
            renderTable(lastRenderedProperties, lastRenderedHeaderData, lastRenderedExport, lastRenderedParentArray);
        }
    });
}

// Expand All
if (expandAllBtn) {
    expandAllBtn.addEventListener("click", () => {
        // We only need to expand the top-level export nodes to show their first children
        // Sub-children (inside structs/arrays) can also be expanded if they exist
        const roots = document.querySelectorAll("#treeRoot > li");
        roots.forEach(li => {
            const toggle = li.querySelector(".toggle-box");
            const ul = li.querySelector(".nested-group");

            if (toggle && !toggle.classList.contains("empty") && ul) {
                // Show the node
                ul.classList.add("show");
                toggle.textContent = "-";

                // Triger silent load only if it hasn't been populated yet
                if (ul.children.length === 0) {
                    // Find the content div to get the onClick handler
                    const content = li.querySelector(".node-content");
                    if (content && content.expandSilent) {
                        content.expandSilent();
                    }
                }
            }
        });

        // Also show any already-populated sub-groups
        document.querySelectorAll(".nested-group").forEach(ul => {
            ul.classList.add("show");
            const toggle = ul.parentElement.querySelector(".toggle-box");
            if (toggle && !toggle.classList.contains("empty")) toggle.textContent = "-";
        });
    });
}

// Collapse All
if (collapseAllBtn) {
    collapseAllBtn.addEventListener("click", () => {
        document.querySelectorAll(".nested-group").forEach(ul => {
            ul.classList.remove("show");
            const toggle = ul.parentElement.querySelector(".toggle-box");
            if (toggle && !toggle.classList.contains("empty")) toggle.textContent = "+";
        });
    });
}

// Sort Order change
if (sortOrderSelect) {
    sortOrderSelect.addEventListener("change", () => {
        currentSortOrder = sortOrderSelect.value;
        localStorage.setItem("sortOrder", currentSortOrder);
        // Re-render current table if any
        if (lastRenderedProperties) {
            renderTable(lastRenderedProperties, lastRenderedHeaderData, lastRenderedExport, lastRenderedParentArray);
        }
    });
}

// Zoom control functions
function updateZoom(level) {
    level = Math.max(0, Math.min(10, level));
    currentZoom = level;
    var scale = 1.0 - (level * 0.05);
    document.documentElement.style.setProperty("--zoom-scale", scale);
    if (zoomValue) zoomValue.textContent = level.toString();
    if (zoomMinus) zoomMinus.disabled = level === 0;
    if (zoomPlus) zoomPlus.disabled = level === 10;
    localStorage.setItem("zoomLevel", level.toString());
}

if (zoomMinus) {
    zoomMinus.addEventListener("click", () => {
        if (currentZoom > 0) updateZoom(currentZoom - 1);
    });
}

if (zoomPlus) {
    zoomPlus.addEventListener("click", () => {
        if (currentZoom < 10) updateZoom(currentZoom + 1);
    });
}

// About Developer button
if (hexEditorBtn) {
    hexEditorBtn.addEventListener("click", () => {
        const isLight = document.body.classList.contains('light-theme');
        const theme = isLight ? 'light' : 'dark';
        window.location.href = `xev.html?theme=${theme}`;
    });
}

if (aboutDevBtn && aboutOverlay) {
    aboutDevBtn.addEventListener("click", () => {
        // Do not close settings, let About stack on top
        aboutOverlay.classList.add("show");
    });
}

if (aboutClose && aboutOverlay) {
    aboutClose.addEventListener("click", () => {
        aboutOverlay.classList.remove("show");
    });
}

// Close About modal when clicking outside
if (aboutOverlay) {
    aboutOverlay.addEventListener("click", (e) => {
        if (e.target === aboutOverlay) aboutOverlay.classList.remove("show");
    });
}

// Undo/Redo button listeners
var undoBtn = document.getElementById("undoBtn");
var redoBtn = document.getElementById("redoBtn");

if (undoBtn) {
    undoBtn.addEventListener("click", () => {
        HistoryManager.undo();
    });
}

if (redoBtn) {
    redoBtn.addEventListener("click", () => {
        HistoryManager.redo();
    });
}

// Initialize button states
HistoryManager.updateButtonStates();

// Helper function to show toast message (with fallback to alert for desktop)
function showToast(message) {
    if (window.Android && typeof window.Android.showToast === 'function') {
        window.Android.showToast(message);
    } else {
        // Fallback for desktop/browser
        alert(message);
    }
}

// Helper function to convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function rebuildUexp(enableDebug = false, rebuildAll = false) {
    if (!globalExports || !globalHeader)
        return { buffer: null, exportOffsets: null };

    debugLog(`[UPDATE] Starting rebuildUexp with NameMap size: ${globalNameMap.length}`);

    const writer = new UAssetBinaryWriter(globalUExpBuffer?.byteLength || 1024 * 1024);
    const propWriter = new UAssetPropertyWriter(writer, globalNameMap, enableDebug);
    const exportOffsets = new Map();

    // 1. Orijinal dosyanın "Export" kısmının nerede bittiğini bulalım (Tail data tespiti için)
    let maxOriginalOffset = 0;
    if (globalHeader && globalUExpBuffer) {
        // Sadece .uexp kullanan dosyalar için hesaplama
        for (const exp of globalExports) {
            // exp.serialOffset hala orijinal offset değeridir
            const end = exp.serialOffset + exp.serialSize;
            if (end > maxOriginalOffset) maxOriginalOffset = end;
        }
        // Header boyutunu çıkararak .uexp içindeki relative offset'i bul
        maxOriginalOffset -= globalHeader.totalHeaderSize;
    }

    if (enableDebug) {
        debugLog("--- REBUILDING FILE ---");
        debugLog(`Debug Mode: ${enableDebug ? "ON" : "OFF"}`);
        debugLog(`Total Exports: ${globalExports.length}`);
        debugLog(`Detected Original Export End: ${maxOriginalOffset}`);
    }

    let modifiedCount = 0;
    let copiedCount = 0;
    let errorCount = 0;

    // 2. Exportları Yaz
    if (enableDebug) {
        debugLog(`[rebuildUexp] === WRITING EXPORTS ===`);
        debugLog(`[rebuildUexp] Total exports: ${globalExports.length}`);
        debugLog(`[rebuildUexp] Rebuild all: ${rebuildAll}`);
        debugLog(`[rebuildUexp] Global header totalHeaderSize: ${globalHeader.totalHeaderSize}`);
        debugLog(`[rebuildUexp] UExp buffer size: ${globalUExpBuffer ? globalUExpBuffer.byteLength : 0}`);
        debugLog(`[rebuildUexp] UAsset buffer size: ${globalUAssetBuffer ? globalUAssetBuffer.byteLength : 0}`);
    }

    for (let i = 0; i < globalExports.length; i++) {
        const exp = globalExports[i];
        let originalBytes = null;

        if (enableDebug && (i < 3 || i === 64 || i === 65)) {
            debugLog(`[rebuildUexp] Export ${i}: serialOffset=${exp.serialOffset}, serialSize=${exp.serialSize}, isModified=${exp.isModified || false}`);
        }

        // Orijinal baytları al
        if (exp.serialSize > 0 && exp.serialSize < Number.MAX_SAFE_INTEGER) {
            try {
                if (exp.serialOffset >= globalHeader.totalHeaderSize && globalUExpBuffer) {
                    const relativeOffset = exp.serialOffset - globalHeader.totalHeaderSize;
                    // Ensure relativeOffset is within buffer bounds
                    if (relativeOffset >= 0 && relativeOffset + exp.serialSize <= globalUExpBuffer.byteLength) {
                        originalBytes = new Uint8Array(globalUExpBuffer, relativeOffset, exp.serialSize);
                        if (enableDebug && (i < 3 || i === 64 || i === 65)) {
                            debugLog(`[rebuildUexp]   Export ${i}: Read from UExp buffer at relative offset ${relativeOffset}`);
                        }
                    } else {
                        if (enableDebug) debugWarn(`[rebuildUexp] Export ${i}: Invalid UExp buffer range (offset: ${relativeOffset}, size: ${exp.serialSize}, buffer: ${globalUExpBuffer.byteLength})`);
                    }
                } else if (globalUAssetBuffer && exp.serialOffset >= 0) {
                    // Ensure serialOffset is within buffer bounds
                    if (exp.serialOffset + exp.serialSize <= globalUAssetBuffer.byteLength) {
                        originalBytes = new Uint8Array(globalUAssetBuffer, exp.serialOffset, exp.serialSize);
                        if (enableDebug && (i < 3 || i === 64 || i === 65)) {
                            debugLog(`[rebuildUexp]   Export ${i}: Read from UAsset buffer at offset ${exp.serialOffset}`);
                        }
                    } else {
                        if (enableDebug) debugWarn(`[rebuildUexp] Export ${i}: Invalid UAsset buffer range (offset: ${exp.serialOffset}, size: ${exp.serialSize}, buffer: ${globalUAssetBuffer.byteLength})`);
                    }
                } else {
                    if (enableDebug && (i < 3 || i === 64 || i === 65)) {
                        debugWarn(`[rebuildUexp] Export ${i}: Cannot determine source buffer (offset: ${exp.serialOffset}, headerSize: ${globalHeader.totalHeaderSize}, hasUExp: ${!!globalUExpBuffer}, hasUAsset: ${!!globalUAssetBuffer})`);
                    }
                }
            } catch (e) {
                if (enableDebug) debugWarn(`[rebuildUexp] Error reading original bytes for export ${i}: ${e}`);
                originalBytes = null;
            }
        } else if (enableDebug && exp.serialSize > 0) {
            debugWarn(`[rebuildUexp] Export ${i}: Invalid serialSize: ${exp.serialSize} (max: ${Number.MAX_SAFE_INTEGER})`);
        }

        const exportStartOffset = writer.getPosition();
        // Check if export should be rebuilt: either rebuildAll is true, or export is marked as modified and has properties
        const shouldRebuild = rebuildAll || (exp.isModified === true && exp.properties && (exp.properties.length > 0 || exp.__dfInserted || exp.__dfDeleted));

        if (enableDebug && (i < 3 || i === 64 || i === 65)) {
            debugLog(`[rebuildUexp]   Export ${i}: shouldRebuild=${shouldRebuild}, isModified=${exp.isModified || false}, hasProperties=${!!exp.properties}, propertiesCount=${exp.properties ? exp.properties.length : 0}, startOffset=${exportStartOffset}`);
        }

        if (shouldRebuild && exp.properties) {
            try {
                if (exp.dtInfo && exp.dtInfo.rows && exp.dtInfo.rows.length > 0) {
                    const tableProps = exp.properties.filter(function (p) { return !p.__row; });
                    propWriter.writeProperties(tableProps);
                    writer.writeInt32(0);
                    writer.writeInt32(exp.dtInfo.rows.length);
                    for (let ri = 0; ri < exp.dtInfo.rows.length; ri++) {
                        const row = exp.dtInfo.rows[ri];
                        propWriter.writeFName(row.name);
                        propWriter.writeProperties(row.props);
                    }
                } else {
                    propWriter.writeProperties(exp.properties);
                }

                // Extra Data (Padding inside export)
                if (exp.extraData) {
                    writer.writeBytes(exp.extraData);
                }

                const exportEndOffset = writer.getPosition();
                const newSize = Math.max(0, exportEndOffset - exportStartOffset);
                exportOffsets.set(i, { offset: exportStartOffset, size: newSize });
                modifiedCount++;

                if (enableDebug && (i < 3 || i === 64 || i === 65)) {
                    debugLog(`[rebuildUexp]   Export ${i}: Rebuilt successfully, size: ${newSize} bytes (original: ${exp.serialSize})`);
                }

            } catch (e) {
                debugError(`[Export ${i + 1}] Error rebuilding export`, e);
                if (enableDebug) {
                    debugError(`[rebuildUexp] Export ${i}: Rebuild failed, falling back to copy`);
                }
                // Hata olursa orijinali kopyala
                if (originalBytes) {
                    writer.writeBytes(originalBytes);
                    const exportEndOffset = writer.getPosition();
                    const newSize = Math.max(0, exportEndOffset - exportStartOffset);
                    exportOffsets.set(i, { offset: exportStartOffset, size: newSize });
                    copiedCount++;
                } else {
                    exportOffsets.set(i, { offset: exportStartOffset, size: 0 });
                }
                errorCount++;
            }
        } else {
            // Değişiklik yoksa orijinali kopyala
            if (originalBytes && originalBytes.length > 0) {
                writer.writeBytes(originalBytes);
                const exportEndOffset = writer.getPosition();
                const newSize = Math.max(0, exportEndOffset - exportStartOffset);
                exportOffsets.set(i, { offset: exportStartOffset, size: newSize });
                copiedCount++;
            } else {
                exportOffsets.set(i, { offset: exportStartOffset, size: 0 });
            }
        }
    }

    // 3. Tail Data'yı Kopyala (Dosyanın sonundaki artık veriler)
    // Bu adım eksik olduğu için dosya kısalıyordu
    if (globalUExpBuffer && maxOriginalOffset < globalUExpBuffer.byteLength) {
        const tailSize = globalUExpBuffer.byteLength - maxOriginalOffset;
        if (tailSize > 0) {
            if (enableDebug) {
                debugLog(`[Tail Data] Copying ${tailSize} bytes from end of file (AssetRegistry/Padding/Thumbnails)`);
            }
            const tailData = new Uint8Array(globalUExpBuffer, maxOriginalOffset, tailSize);
            writer.writeBytes(tailData);
        }
    }

    let finalSize = writer.getPosition();
    const originalSize = globalUExpBuffer?.byteLength || 0;

    // 4. Final Alignment (İsteğe bağlı, genellikle Tail Data zaten hizalıdır ama garanti olsun)
    const alignment = 4;
    const paddingNeeded = (alignment - (finalSize % alignment)) % alignment;
    if (paddingNeeded > 0) {
        // Eğer orijinal dosya da hizalı değilse ve biz tail data eklediysek, 
        // burası gereksiz padding ekleyebilir ama UE genellikle 4-byte hizalama sever.
        // Ancak orijinal dosya 22430 ise (4'e bölünmez), padding eklememek daha güvenli olabilir.
        // Şimdilik sadece orijinal boyut hizalıysa biz de hizalayalım mantığı güdebiliriz
        // VEYA sadece tail data kopyaladıysak buna gerek kalmayabilir.

        // Güvenlik önlemi: Eğer tail data kopyalamadıysak (dosya sıfırdan yapılıyorsa) padding ekle.
        if (!globalUExpBuffer) {
            for (let i = 0; i < paddingNeeded; i++) {
                writer.writeUInt8(0);
            }
        }
    }

    finalSize = writer.getPosition();

    debugInfo("\n--- REBUILD SUMMARY ---");
    debugInfo(`Total Exports: ${globalExports.length}`);
    debugInfo(`  \u2705 Rebuilt: ${modifiedCount}`);
    debugInfo(`  \u{1F4CB} Copied: ${copiedCount}`);

    debugInfo(`File Sizes:`);
    debugInfo(`  Original: ${originalSize} bytes`);
    debugInfo(`  New: ${finalSize} bytes`);
    debugInfo(`  Difference: ${finalSize - originalSize} bytes`);

    return { buffer: writer.getBuffer(), exportOffsets: exportOffsets };
}

// ============================================
// REBUILD UASSET WITH MODIFIED NAME MAP (HYBRID APPROACH)
// ============================================
// This function rebuilds the .uasset file when Name Map has been modified
// Uses HYBRID approach:
// - If all new names fit within original space: Fixed-Size Patching (fast, no offset changes)
// - If any name needs more space: Full Rebuild with offset shifting
function rebuildUAssetWithNameMap(enableDebug = false) {
    if (!globalHeader || !globalNameMap || !globalUAssetBuffer || !originalNameMap) {
        debugError("[UASSET_REBUILD] Missing required data for rebuild");
        return null;
    }

    debugLog("[UASSET_REBUILD] Starting simple fixed-size name map patch...");

    const nameOffset = globalHeader.nameOffset;
    const hasHash = globalHeader.fileVersionUE4 >= 504;
    const encoder = new TextEncoder();

    // Create a copy of the original buffer to work on
    const newBuffer = globalUAssetBuffer.slice(0);
    const newBytes = new Uint8Array(newBuffer);
    const view = new DataView(newBuffer);

    let readPos = nameOffset;
    let modifiedCount = 0;

    for (let i = 0; i < globalNameMap.length; i++) {
        const entryStart = readPos;

        // Read the original length prefix
        const lengthPrefix = view.getInt32(readPos, true);
        readPos += 4;

        let stringBytesSize;
        if (lengthPrefix < 0) {
            // UTF-16: length is negative, each char is 2 bytes
            stringBytesSize = Math.abs(lengthPrefix) * 2;
        } else {
            // Latin-1/ASCII: length is positive, each char is 1 byte
            stringBytesSize = lengthPrefix;
        }

        const newName = globalNameMap[i];
        const originalName = originalNameMap[i];

        if (newName !== originalName) {
            modifiedCount++;

            const strBytes = encoder.encode(newName);
            const stringWritePos = entryStart + 4;

            // Calculate how much we can write (must fit in original space)
            // Note: lengthPrefix includes the null terminator
            const maxAllowedBytes = stringBytesSize;

            // We need room for at least one null terminator if we want it to be a valid string
            // but we'll just truncate and provide at least one null if possible.
            // If the user provided a string exactly fitting the space, we'll write it 
            // and the last byte should be 0 (null) unless they filled every byte.
            // But standard practice is: write bytes, write null, write padding.

            let bytesToWrite = strBytes.length;
            if (bytesToWrite >= maxAllowedBytes) {
                // Truncate to leave room for null terminator at the very end of space
                bytesToWrite = maxAllowedBytes - 1;
            }

            // 1. Write the new string bytes
            for (let j = 0; j < bytesToWrite; j++) {
                newBytes[stringWritePos + j] = strBytes[j];
            }

            // 2. Write null terminator immediately after content
            newBytes[stringWritePos + bytesToWrite] = 0;

            // 3. Fill the remaining original space with null bytes (padding)
            for (let j = bytesToWrite + 1; j < stringBytesSize; j++) {
                newBytes[stringWritePos + j] = 0;
            }

            // 4. Zero out hash for security (modified names should have 0 hash in UE4/5)
            if (hasHash) {
                const hashPos = stringWritePos + stringBytesSize;
                view.setUint32(hashPos, 0, true);
            }

            debugLog(`[UASSET_REBUILD] Patched entry ${i}: "${originalName}" -> "${newName}" (Padded with ${stringBytesSize - (bytesToWrite + 1)} bytes)`);
        }

        readPos += stringBytesSize;
        if (hasHash) {
            readPos += 4;
        }
    }

    debugLog(`[UASSET_REBUILD] Patch complete. Modified ${modifiedCount} entries. File size unchanged.`);

    return {
        buffer: newBuffer,
        size: newBuffer.byteLength,
        updatedHeader: globalHeader
    };
}

// Calculate the byte size of a Name Map in disk format
// Each name entry consists of:
//   - Int32: String length (positive = Latin1, negative = UTF-16)
//   - String bytes + null terminator
//   - UInt32 hash (only for UE4.23+ / fileVersionUE4 >= 504)
function calculateNameMapSize(nameMap, fileVersionUE4) {
    if (!nameMap || !Array.isArray(nameMap)) {
        debugWarn(`[calculateNameMapSize] Invalid nameMap provided`);
        return 0;
    }

    let totalSize = 0;
    const hasHash = fileVersionUE4 >= 504;

    for (let i = 0; i < nameMap.length; i++) {
        const name = nameMap[i] || '';

        // Encode string as UTF-8 (which for ASCII/Latin1 characters is equivalent)
        const encoder = new TextEncoder();
        const strBytes = encoder.encode(name);

        // FString disk format:
        // - 4 bytes: Int32 length (includes null terminator, positive for Latin1)
        // - N bytes: String content
        // - 1 byte: Null terminator
        const lengthPrefix = 4;
        const stringContent = strBytes.length;
        const nullTerminator = 1;

        // Entry size: length prefix + string bytes + null
        let entrySize = lengthPrefix + stringContent + nullTerminator;

        // Add hash for UE4.23+
        if (hasHash) {
            entrySize += 4; // 2x UInt16 = 4 bytes
        }

        totalSize += entrySize;
    }

    debugLog(`[calculateNameMapSize] Calculated size: ${totalSize} bytes for ${nameMap.length} entries (hasHash: ${hasHash})`);

    return totalSize;
}

if (saveBtn && window.location.pathname.includes('viewer.html')) {
    saveBtn.onclick = async () => {
        if (globalExports.length === 0) {
            showToast("没有可保存的数据");
            return;
        }
        const enableDebug = isDebugEnabled();
        const urlParams = new URLSearchParams(window.location.search);
        const rebuildAll = urlParams.get("rebuildall") === "true" || localStorage.getItem("uasset_rebuildall") === "true";

        debugInfo("\n--- SAVING FILES ---");
        debugLog(`[SAVE] nameMapModified: ${nameMapModified}`);

        // Step 1: Rebuild .uexp file
        const uexpResult = await rebuildUexp(enableDebug, rebuildAll);
        if (!uexpResult || !uexpResult.buffer) {
            debugError("Failed to rebuild .uexp file!");
            return;
        }

        // Step 2: Handle .uasset file
        let uassetBuffer;
        let uassetLabel;

        if (typeof nameMapNeedsGrow !== "undefined" && nameMapNeedsGrow) {
            // 插入新属性带来了新名字 —— 名称表需要扩容，后续表整体后移
            debugInfo("📝 名称表需要扩容 - 重建 .uasset...");
            const growResult = growUAssetNameMap(enableDebug);
            if (!growResult || !growResult.buffer) {
                debugError("名称表扩容失败！");
                showToast("名称表扩容失败");
                return;
            }
            uassetBuffer = growResult.buffer;
            uassetLabel = "GROWN(+delta)";
            globalHeader = growResult.updatedHeader;
            globalUAssetBuffer = growResult.buffer;
            originalNameMap = [...globalNameMap];
            nameMapNeedsGrow = false;
            nameMapModified = false;
            debugInfo(`✅ .uasset 名称表已扩容 (${uassetBuffer.byteLength} bytes, delta=${growResult.delta})`);
        } else if (nameMapModified) {
            // Name Map was modified - rebuild .uasset
            debugInfo("📝 Name Map was modified - rebuilding .uasset...");

            const uassetResult = rebuildUAssetWithNameMap(enableDebug);
            if (!uassetResult || !uassetResult.buffer) {
                debugError("Failed to rebuild .uasset with modified Name Map!");
                showToast("名称表保存失败");
                return;
            }

            uassetBuffer = uassetResult.buffer;
            uassetLabel = "REBUILT";
            debugInfo(`✅ .uasset rebuilt with new Name Map (${uassetBuffer.byteLength} bytes)`);

            // Update global buffers and header for consistency in subsequent saves
            globalUAssetBuffer = uassetResult.buffer;
            globalHeader = uassetResult.updatedHeader;

            // Update originalNameMap to match current state for next save cycle
            originalNameMap = [...globalNameMap];
            debugLog(`[SAVE] Updated globalUAssetBuffer (${globalUAssetBuffer.byteLength} bytes) and originalNameMap for next save`);
        } else {
            // No Name Map changes - use original .uasset
            if (!globalUAssetBuffer) {
                debugError("Original .uasset buffer not available!");
                return;
            }

            uassetBuffer = globalUAssetBuffer;
            uassetLabel = "ORIGINAL";
            debugInfo("✅ Using original .uasset file (no Name Map modifications)");
        }

        // 插入属性会让导出变长/变短，导出表里的 serialSize / serialOffset 必须同步校正
        try {
            uassetBuffer = patchExportTableForNewOffsets(uassetBuffer, uexpResult.exportOffsets);
            if (uexpResult.buffer) {
                globalUExpBuffer = new Uint8Array(uexpResult.buffer).buffer.slice(0);
            }
        } catch (patchErr) {
            debugError("导出表校正失败: " + patchErr.message);
            showToast("导出表校正失败");
            return;
        }

        // 回读校验：用即将写出的字节重新解析，结构不对就不落盘
        try {
            var verifyErr = dfVerifySaved(uassetBuffer, uexpResult.buffer);
            if (verifyErr) {
                debugError("[VERIFY] 校验失败: " + verifyErr);
                showToast("保存中止：结构校验失败（" + verifyErr + "）");
                return;
            }
            debugInfo("✅ 回读校验通过");
        } catch (ve) {
            debugError("[VERIFY] 校验异常: " + ve.message);
            showToast("保存中止：校验异常");
            return;
        }

        debugInfo(`  .uasset size: ${uassetBuffer.byteLength} bytes [${uassetLabel}]`);

        // Step 3: Save both files
        const baseFileName = fileInfo.textContent?.split(" ")[0].replace(".uasset", "").replace(".uexp", "") || "modded";

        // Check if Android interface is available
        if (window.Android && typeof window.Android.saveFile === 'function') {
            // Android mode: Use JavaScript interface to save files
            debugInfo("📱 Using Android file save interface");

            try {
                // Convert buffers to Base64
                const uassetBase64 = arrayBufferToBase64(uassetBuffer);
                const uexpBase64 = arrayBufferToBase64(uexpResult.buffer.buffer);

                // Save .uasset file
                window.Android.saveFile(uassetBase64, `${baseFileName}.uasset`, "application/octet-stream");
                debugInfo(`  ✅ ${baseFileName}.uasset saved to Downloads/AssetEditor`);

                // Save .uexp file
                window.Android.saveFile(uexpBase64, `${baseFileName}.uexp`, "application/octet-stream");
                debugInfo(`  ✅ ${baseFileName}.uexp saved to Downloads/AssetEditor`);

                debugInfo("\n✅ Both files saved to Downloads/AssetEditor directory!");
                debugInfo(`  📄 ${baseFileName}.uasset (${uassetBuffer.byteLength} bytes) [${uassetLabel}]`);
                debugInfo(`  📄 ${baseFileName}.uexp (${uexpResult.buffer.length} bytes) [REBUILT]`);

                // Reset modification flag after successful save
                if (nameMapModified) {
                    nameMapModified = false;
                    originalNameMap = [...globalNameMap];
                    debugLog(`[SAVE] Name Map modification flags reset`);
                }
            } catch (error) {
                debugError("Error saving files via Android interface: " + error.message);
                showToast("保存文件失败，请检查控制台");
            }
        } else {
            // Desktop mode: Use Blob/Anchor tag download (fallback)
            debugInfo("🖥️ Using desktop file download");

            // Download .uasset
            const uassetBlob = new Blob([uassetBuffer], { type: "application/octet-stream" });
            const uassetLink = document.createElement("a");
            uassetLink.href = URL.createObjectURL(uassetBlob);
            uassetLink.download = `${baseFileName}.uasset`;
            uassetLink.click();

            // Download .uexp (REBUILT)
            const uexpBlob = new Blob([uexpResult.buffer.buffer], { type: "application/octet-stream" });
            const uexpLink = document.createElement("a");
            uexpLink.href = URL.createObjectURL(uexpBlob);
            uexpLink.download = `${baseFileName}.uexp`;
            uexpLink.click();

            debugInfo("\n✅ Both files downloaded!");
            debugInfo(`  📄 ${baseFileName}.uasset (${uassetBuffer.byteLength} bytes) [${uassetLabel}]`);
            debugInfo(`  📄 ${baseFileName}.uexp (${uexpResult.buffer.length} bytes) [REBUILT]`);

            // Reset modification flag after successful save
            if (nameMapModified) {
                nameMapModified = false;
                originalNameMap = [...globalNameMap];
                debugLog(`[SAVE] Name Map modification flags reset`);
            }
        }
    };
}

// ============================================
// PRODUCT TOUR (SPOTLIGHT) SYSTEM
// ============================================
(function () {
    function injectTour() {
        if (document.getElementById('tourOverlay')) return;

        const style = document.createElement('style');
        style.id = 'tour-styles';
        style.textContent = `
            .tour-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 999999; display: none; opacity: 0; transition: opacity 0.5s ease; pointer-events: none; }
            .tour-overlay.show { display: block; opacity: 1; pointer-events: auto; }
            .tour-svg-mask { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
            .tour-backdrop-path { fill: rgba(0, 0, 0, 0.65); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); mask: url(#tour-mask); -webkit-mask: url(#tour-mask); transition: fill 0.5s ease; }
            .tour-tooltip { position: fixed !important; z-index: 1000001; background: #1a1a1a !important; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px; padding: 18px 20px; width: 280px; max-width: 90vw; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.03); transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1); opacity: 0; transform: translateY(10px) scale(0.97); pointer-events: auto; font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif; }
            .tour-tooltip.active { opacity: 1 !important; transform: translateY(0) scale(1); }
            .tour-content { font-size: 14px; line-height: 1.65; color: #d4d4d4 !important; margin: 0 0 18px 0; font-weight: 400; min-height: 20px; display: block; letter-spacing: 0.2px; }
            .tour-footer { display: flex; gap: 10px; justify-content: space-between; align-items: center; }
            .tour-step-counter { font-size: 11px; color: #666; font-weight: 500; letter-spacing: 0.5px; }
            .tour-buttons { display: flex; gap: 4px; }
            .tour-prev-btn, .tour-next-btn { border: none; padding: 8px 12px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s ease; display: inline-flex; align-items: center; background: transparent; letter-spacing: 0.3px; }
            .tour-next-btn { color: #4ade80; }
            .tour-next-btn:hover { color: #86efac; }
            .tour-prev-btn { color: #f87171; }
            .tour-prev-btn:hover { color: #fca5a5; }
            #tour-mask-rect { transition: all 0.5s cubic-bezier(0.2, 0.8, 0.2, 1); }
        `;
        document.head.appendChild(style);

        const tourHTML = `
            <div class="tour-overlay" id="tourOverlay">
                <svg class="tour-svg-mask">
                    <defs>
                        <mask id="tour-mask">
                            <rect width="100%" height="100%" fill="white" />
                            <rect id="tour-mask-rect" x="0" y="0" width="0" height="0" rx="10" fill="black" />
                        </mask>
                    </defs>
                    <rect width="100%" height="100%" class="tour-backdrop-path" />
                </svg>
                <div class="tour-tooltip" id="tourTooltip">
                    <p class="tour-content" id="tourContent"></p>
                    <div class="tour-footer">
                        <span class="tour-step-counter" id="tourStepCounter">1 / 15</span>
                        <div class="tour-buttons">
                            <button class="tour-prev-btn" id="tourPrevBtn">Back</button>
                            <button class="tour-next-btn" id="tourNextBtn">Next</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', tourHTML);
    }

    let tourOverlay, tourTooltip, tourContent, tourNextBtn, tourPrevBtn, tourMaskRect;
    let currentStep = 0;

    const steps = [
        {
            page: "viewer.html",
            id: "openBtn",
            content: "Select your Unreal Engine files here to start editing. This is always the first step!"
        },
        {
            page: "viewer.html",
            id: "menuToggle",
            content: "Browse and manage the entire hierarchy of your loaded file from here."
        },
        {
            page: "viewer.html",
            id: "settingsToggle",
            content: "Customize the interface and performance options from here."
        },
        {
            page: "viewer.html",
            id: "rowTheme",
            content: "Quickly switch between Dark and Light themes."
        },
        {
            page: "viewer.html",
            id: "rowZoom",
            content: "Optimize the interface size to your preference using this panel."
        },
        {
            page: "viewer.html",
            id: "rowIcons",
            content: "Hide sidebar icons for a cleaner look."
        },
        {
            page: "viewer.html",
            id: "rowAnim",
            content: "Manage animations for a smoother experience or maximum performance."
        },
        {
            page: "viewer.html",
            id: "rowCompact",
            content: "Enable Compact Mode to see more data on a single screen."
        },
        {
            page: "viewer.html",
            id: "rowSort",
            content: "Easily sort properties by alphabet, type, or original order."
        },
        {
            page: "viewer.html",
            id: "rowModified",
            content: "Filter to show only the values you've changed."
        },
        {
            page: "viewer.html",
            id: "hexEditorBtn",
            content: "Access the advanced Hex Editor to directly manipulate raw binary data. Let's dive in!",
            action: "redirect_hex"
        },
        {
            page: "xev.html",
            id: "btnGoHex",
            content: "View and edit your files in hex format. The main tool for binary editing!"
        },
        {
            page: "xev.html",
            id: "btnGoTools",
            content: "Split or merge files. You can break large files into smaller parts."
        },
        {
            page: "xev.html",
            id: "btnGoStrings",
            content: "Automatically find and inspect text strings within files."
        },
        {
            page: "xev.html",
            id: "btnGoHashes",
            content: "Calculate SHA-256, SHA-1, and CRC32 hash values. Verify file integrity."
        },
        {
            page: "xev.html",
            id: "btnGoConverter",
            content: "Quickly convert between Hex, Decimal, Binary, Octal, and ASCII."
        },
        {
            page: "xev.html",
            id: "btnGoDiff",
            content: "Compare two UAsset files and see the differences."
        },
        {
            page: "xev.html",
            id: "btnGoEntropy",
            content: "View the entropy map of a file. Detect encrypted or compressed regions."
        },
        {
            page: "xev.html",
            id: "btnGoSig",
            content: "Scan file signatures and identify known file formats."
        },
        {
            page: "xev.html",
            id: "btnGoEncode",
            content: "Easily encode and decode Base64."
        },
        {
            page: "viewer.html",
            id: "historyGroup",
            content: "Don't be afraid to make mistakes! You can undo or redo changes at any time."
        },
        {
            page: "viewer.html",
            id: "saveBtn",
            content: "When you're done, download your modified files as a package from here."
        }
    ];

    function isCurrentPage(stepPage) {
        const path = window.location.pathname;
        return path.includes(stepPage);
    }

    function updateTour() {
        try {
            const step = steps[currentStep];
            if (!step) return;

            // Ensure elements are assigned
            tourOverlay = document.getElementById("tourOverlay");
            tourTooltip = document.getElementById("tourTooltip");
            tourContent = document.getElementById("tourContent");
            tourNextBtn = document.getElementById("tourNextBtn");
            tourPrevBtn = document.getElementById("tourPrevBtn");
            tourMaskRect = document.getElementById("tour-mask-rect");

            if (!tourOverlay || !tourTooltip || !tourContent || !tourNextBtn || !tourMaskRect) {
                return;
            }

            // If the step belongs to a different page, check if we should skip or redirect
            if (!isCurrentPage(step.page)) {
                const params = new URLSearchParams(window.location.search);
                if (params.get('tour') === 'true' && !localStorage.getItem("tourCurrentStep") && currentStep === 0) {
                    const firstStepForThisPage = steps.findIndex(s => isCurrentPage(s.page));
                    if (firstStepForThisPage !== -1) {
                        currentStep = firstStepForThisPage;
                        updateTour();
                        return;
                    }
                }
                nextStep();
                return;
            }

            const targetEl = document.getElementById(step.id);
            if (!targetEl) {
                if (currentStep < steps.length - 1) {
                    currentStep++;
                    updateTour();
                }
                return;
            }

            // Handle elements that might be hidden by default
            const isHidden = window.getComputedStyle(targetEl).display === 'none';
            if (isHidden || step.id === 'historyGroup' || step.id === 'saveBtn') {
                const displayType = (step.id === 'saveBtn' || step.id.includes('Btn') || step.id.includes('Group')) ? 'flex' : 'block';
                targetEl.style.display = displayType;
                targetEl.style.visibility = 'visible';
                targetEl.style.opacity = '1';
                targetEl.setAttribute('data-tour-visible', 'true');

                if (step.id === 'historyGroup') {
                    targetEl.querySelectorAll('.history-btn').forEach(btn => {
                        btn.style.display = 'flex';
                    });
                }
            }

            // Hide openBtn when highlighting saveBtn
            const openBtn = document.getElementById('openBtn');
            if (step.id === 'saveBtn' && openBtn) {
                openBtn.style.display = 'none';
                openBtn.setAttribute('data-tour-hidden', 'true');
            } else if (openBtn && openBtn.getAttribute('data-tour-hidden') === 'true') {
                openBtn.style.display = '';
                openBtn.removeAttribute('data-tour-hidden');
            }

            const settingsOverlay = document.getElementById('settingsOverlay');
            const isSettingsItem = targetEl.closest('.settings-modal');

            if (isSettingsItem && settingsOverlay) {
                settingsOverlay.classList.add('show');
                setTimeout(() => {
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            } else if (settingsOverlay) {
                if (settingsOverlay.classList.contains('show') && !document.body.classList.contains('manual-settings')) {
                    settingsOverlay.classList.remove('show');
                }
            }

            tourContent.textContent = step.content;
            tourPrevBtn.style.display = currentStep === 0 ? "none" : "inline-flex";
            tourNextBtn.textContent = currentStep === steps.length - 1 ? "Finish" : "Next";

            // Update step counter
            const stepCounter = document.getElementById('tourStepCounter');
            if (stepCounter) {
                stepCounter.textContent = `${currentStep + 1} / ${steps.length}`;
            }

            tourTooltip.classList.remove("active");
            setTimeout(() => {
                const rect = targetEl.getBoundingClientRect();
                const padding = 6;

                // For large elements like dashboard, use a smaller highlight area
                let highlightWidth = Math.min(rect.width, 300);
                let highlightHeight = Math.min(rect.height, 200);
                let highlightX = rect.left + (rect.width - highlightWidth) / 2;
                let highlightY = rect.top + (rect.height - highlightHeight) / 2;

                // If element is very large (like dashboard), just highlight a portion
                if (rect.width > 400 || rect.height > 400) {
                    highlightX = rect.left + 20;
                    highlightY = rect.top + 20;
                    highlightWidth = Math.min(rect.width - 40, 280);
                    highlightHeight = Math.min(rect.height - 40, 150);
                }

                tourMaskRect.setAttribute("x", highlightX - padding);
                tourMaskRect.setAttribute("y", highlightY - padding);
                tourMaskRect.setAttribute("width", highlightWidth + padding * 2);
                tourMaskRect.setAttribute("height", highlightHeight + padding * 2);

                const tooltipRect = tourTooltip.getBoundingClientRect();

                // Center tooltip horizontally on screen for large elements
                let left, top;
                if (rect.width > 400) {
                    left = (window.innerWidth - tooltipRect.width) / 2;
                    top = highlightY + highlightHeight + 30;
                } else {
                    left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
                    top = rect.bottom + 20;
                }

                // Ensure tooltip stays on screen
                if (left < 20) left = 20;
                if (left + tooltipRect.width > window.innerWidth - 20) {
                    left = window.innerWidth - tooltipRect.width - 20;
                }

                if (top + tooltipRect.height > window.innerHeight - 20) {
                    top = Math.max(20, highlightY - tooltipRect.height - 20);
                }
                if (top < 20) top = 20;

                tourTooltip.style.top = `${top}px`;
                tourTooltip.style.left = `${left}px`;
                tourOverlay.classList.add("show");
                tourTooltip.classList.add("active");
            }, 400);
        } catch (e) {
            console.error("Tour update failed", e);
        }
    }

    function nextStep() {
        // Clean up previously force-shown elements correctly
        const forced = document.querySelectorAll('[data-tour-visible="true"]');
        forced.forEach(el => {
            el.style.display = '';
            el.style.visibility = '';
            el.style.opacity = '';
            el.removeAttribute('data-tour-visible');
        });

        const currentStepData = steps[currentStep];

        // Handle special actions
        if (currentStepData.action === 'redirect_hex') {
            const isLight = document.body.classList.contains('light-theme') || localStorage.getItem('theme') === 'light';
            const theme = isLight ? 'light' : 'dark';
            localStorage.setItem("tourCurrentStep", currentStep + 1);
            window.location.href = `xev.html?theme=${theme}&tour=true`;
            return;
        }

        if (currentStep < steps.length - 1) {
            const nextStepData = steps[currentStep + 1];

            // If next step is on a different page and we are NOT redirecting via action, 
            // handle back-to-viewer or similar
            if (!isCurrentPage(nextStepData.page)) {
                // Detect theme from body class OR localStorage
                const isLight = document.body.classList.contains('light-theme') || localStorage.getItem('theme') === 'light';
                const theme = isLight ? 'light' : 'dark';
                localStorage.setItem("tourCurrentStep", currentStep + 1);
                window.location.href = `${nextStepData.page}?theme=${theme}&tour=true`;
                return;
            }

            currentStep++;
            if (tourTooltip) tourTooltip.classList.remove("active");
            setTimeout(updateTour, 400);
        } else {
            finishTour();
        }
    }

    function prevStep() {
        if (currentStep > 0) {
            const prevStepData = steps[currentStep - 1];

            if (!isCurrentPage(prevStepData.page)) {
                // Detect theme from body class OR localStorage
                const isLight = document.body.classList.contains('light-theme') || localStorage.getItem('theme') === 'light';
                const theme = isLight ? 'light' : 'dark';
                localStorage.setItem("tourCurrentStep", currentStep - 1);
                window.location.href = `${prevStepData.page}?theme=${theme}&tour=true`;
                return;
            }

            currentStep--;
            if (tourTooltip) tourTooltip.classList.remove("active");
            setTimeout(updateTour, 400);
        }
    }

    function prepareTourListeners() {
        tourNextBtn = document.getElementById("tourNextBtn");
        tourPrevBtn = document.getElementById("tourPrevBtn");

        if (tourNextBtn) tourNextBtn.onclick = nextStep;
        if (tourPrevBtn) tourPrevBtn.onclick = prevStep;
    }

    function startTour() {
        injectTour();
        prepareTourListeners();

        tourOverlay = document.getElementById("tourOverlay");
        if (!tourOverlay) return;

        if (localStorage.getItem("productTourCompleted_v5") === "true") {
            const params = new URLSearchParams(window.location.search);
            if (params.get('tour') !== 'true') return;
        }

        const savedStep = localStorage.getItem("tourCurrentStep");
        const params = new URLSearchParams(window.location.search);

        if (params.get('tour') === 'true' && savedStep) {
            currentStep = parseInt(savedStep);
            localStorage.removeItem("tourCurrentStep");
        } else {
            const firstStep = steps.findIndex(s => isCurrentPage(s.page));
            currentStep = firstStep !== -1 ? firstStep : 0;
        }

        tourOverlay.classList.add("show");
        setTimeout(updateTour, 100);
    }

    function finishTour() {
        // Restore openBtn if it was hidden
        const openBtn = document.getElementById('openBtn');
        if (openBtn) {
            openBtn.style.display = '';
            openBtn.removeAttribute('data-tour-hidden');
        }

        // Clean up any tour-visible elements - remove inline styles so CSS takes over
        const forced = document.querySelectorAll('[data-tour-visible="true"]');
        forced.forEach(el => {
            el.style.display = '';
            el.style.visibility = '';
            el.style.opacity = '';
            el.removeAttribute('data-tour-visible');
        });

        // Remove inline styles from historyGroup and saveBtn so CSS rules apply
        const historyGroup = document.getElementById('historyGroup');
        const saveBtn = document.getElementById('saveBtn');
        if (historyGroup) historyGroup.style.display = '';
        if (saveBtn) saveBtn.style.display = '';

        if (tourOverlay) {
            tourOverlay.style.opacity = "0";
            setTimeout(() => {
                tourOverlay.classList.remove("show");
                localStorage.setItem("productTourCompleted_v5", "true");

                // Clean URL - remove tour and theme parameters without page reload
                const cleanUrl = window.location.pathname;
                history.replaceState(null, '', cleanUrl);
            }, 500);
        }
        if (document.getElementById('settingsOverlay')) {
            document.getElementById('settingsOverlay').classList.remove('show');
        }
        document.body.classList.remove('manual-settings');
    }

    // Run tour when ready
    window.addEventListener("load", () => {
        // Only start if not completed OR if explicitly requested via URL
        const params = new URLSearchParams(window.location.search);
        if (localStorage.getItem("productTourCompleted_v5") !== "true" || params.get('tour') === 'true') {
            // [ZH] 引导已关闭，直接进主界面
        }
    });

    // Dynamic resize handling
    window.addEventListener("resize", () => {
        if (tourOverlay && tourOverlay.classList.contains("show")) {
            updateTour();
        }
    });
})();

/* =========================================================================
   插入新属性 (Insert New Property) — 固定在属性表最后一行
   只新增功能，不改动原有解析/改值/导出逻辑
   ========================================================================= */
var nameMapNeedsGrow = false;

var DF_TYPE_DEFS = [
    { id: "IntProperty (整数)", ptype: "IntProperty", kind: "num" },
    { id: "Int8Property (8位整数)", ptype: "Int8Property", kind: "num" },
    { id: "Int16Property (16位整数)", ptype: "Int16Property", kind: "num" },
    { id: "Int64Property (64位整数)", ptype: "Int64Property", kind: "num" },
    { id: "FloatProperty (浮点)", ptype: "FloatProperty", kind: "num" },
    { id: "StructProperty - LinearColor (颜色)", ptype: "StructProperty", kind: "struct", struct: "LinearColor", hint: "颜色值 (R,G,B,A 范围 0-1)" },
    { id: "StructProperty - Vector (3D向量)", ptype: "StructProperty", kind: "struct", struct: "Vector", hint: "向量值 (X,Y,Z)" },
    { id: "StructProperty - Rotator (旋转)", ptype: "StructProperty", kind: "struct", struct: "Rotator", hint: "旋转值 (Pitch,Yaw,Roll)" },
    { id: "StructProperty - Vector2D (2D向量)", ptype: "StructProperty", kind: "struct", struct: "Vector2D", hint: "x,y" },
    { id: "StructProperty - Quat (四元数)", ptype: "StructProperty", kind: "struct", struct: "Quat", hint: "四元数 (X,Y,Z,W)" },
    { id: "StructProperty - Vector4 (4D向量)", ptype: "StructProperty", kind: "struct", struct: "Vector4", hint: "4D向量值 (X,Y,Z,W)" },
    { id: "StructProperty - Color (颜色BGRA)", ptype: "StructProperty", kind: "struct", struct: "Color", hint: "颜色值 (R,G,B,A 范围 0-255)" },
    { id: "StructProperty - IntPoint (整数点)", ptype: "StructProperty", kind: "struct", struct: "IntPoint", hint: "x,y" },
    { id: "StructProperty - Plane (平面)", ptype: "StructProperty", kind: "struct", struct: "Plane", hint: "x,y,z,w" },
    { id: "StructProperty - Transform (变换)", ptype: "StructProperty", kind: "struct", struct: "Transform", hint: "变换值 (PX,PY,PZ / QX,QY,QZ,QW / SX,SY,SZ)" },
    { id: "StructProperty - Guid (全局ID)", ptype: "StructProperty", kind: "struct", struct: "Guid", hint: "32 位十六进制，例如 0123456789ABCDEF0123456789ABCDEF" },
    { id: "StructProperty - 自定义Struct (手动输入内容)", ptype: "StructProperty", kind: "hex", struct: "None", hint: "原始字节，十六进制，例如 00 00 80 3F" },
    { id: "BoolProperty (布尔)", ptype: "BoolProperty", kind: "bool" },
    { id: "ObjectProperty (对象引用)", ptype: "ObjectProperty", kind: "objidx", hint: "PackageIndex，0 表示 None" },
    { id: "ClassProperty (类引用)", ptype: "ClassProperty", kind: "objidx", hint: "PackageIndex，0 表示 None" },
    { id: "WeakObjectProperty (弱对象引用)", ptype: "WeakObjectProperty", kind: "objidx", hint: "PackageIndex，0 表示 None" },
    { id: "LazyObjectProperty (懒对象引用)", ptype: "LazyObjectProperty", kind: "lazy", hint: "16 字节 GUID（32 位十六进制）" },
    { id: "AssetObjectProperty (资产对象引用)", ptype: "AssetObjectProperty", kind: "softobj", hint: "/Game/Path/Asset.Asset" },
    { id: "AssetClassProperty (资产类引用)", ptype: "AssetClassProperty", kind: "softobj", hint: "/Script/Engine.Actor" },
    { id: "InterfaceProperty (接口引用)", ptype: "InterfaceProperty", kind: "objidx", hint: "PackageIndex，0 表示 None" },
    { id: "SoftObjectProperty (软对象路径)", ptype: "SoftObjectProperty", kind: "softobj", hint: "/Game/Path/Asset.Asset" },
    { id: "SoftClassProperty (软类路径)", ptype: "SoftClassProperty", kind: "softobj", hint: "/Script/Engine.Actor" },
    { id: "UInt16Property (16位无符号整数)", ptype: "UInt16Property", kind: "num" },
    { id: "UInt32Property (无符号整数)", ptype: "UInt32Property", kind: "num" },
    { id: "UInt64Property (64位整数)", ptype: "UInt64Property", kind: "num" },
    { id: "DoubleProperty (双精度浮点)", ptype: "DoubleProperty", kind: "num" },
    { id: "NameProperty (名称)", ptype: "NameProperty", kind: "name", hint: "必须是名称表里已有的名字（可下拉选）" },
    { id: "StrProperty (字符串)", ptype: "StrProperty", kind: "str" },
    { id: "AnsiStrProperty (ANSI字符串)", ptype: "AnsiStrProperty", kind: "str" },
    { id: "Utf8StrProperty (UTF-8字符串)", ptype: "Utf8StrProperty", kind: "str" },
    { id: "TextProperty (本地化文本)", ptype: "TextProperty", kind: "text" },
    { id: "ByteProperty (字节/枚举值)", ptype: "ByteProperty", kind: "byte", hint: "0-255；或直接填名称（写 FName）" },
    { id: "EnumProperty (枚举)", ptype: "EnumProperty", kind: "enum", hint: "枚举值名称，例如 EWeaponType::Rifle" }
];

function dfFindTypeDef(label) {
    for (var i = 0; i < DF_TYPE_DEFS.length; i++) {
        if (DF_TYPE_DEFS[i].id === label) return DF_TYPE_DEFS[i];
    }
    return DF_TYPE_DEFS[0];
}

function dfHexToBytes(text) {
    var clean = String(text || "").replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2 === 1) clean += "0";
    var out = new Uint8Array(clean.length / 2);
    for (var i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
}

function dfParseStruct(structName, raw) {
    var parts = String(raw || "").split(/[,\s]+/).filter(function (s) { return s.length > 0; });
    var n = parts.map(Number);
    function f(i, dflt) {
        var v = n[i];
        return (typeof v === "number" && isFinite(v)) ? v : (dflt === undefined ? 0 : dflt);
    }
    switch (structName) {
        case "Vector":
        case "Rotator":
            return { x: f(0), y: f(1), z: f(2) };
        case "Vector2D":
        case "IntPoint":
            return { x: f(0), y: f(1) };
        case "Quat":
        case "Vector4":
            return { x: f(0), y: f(1), z: f(2), w: f(3, 1) };
        case "Plane":
            return { x: f(0), y: f(1), z: f(2), w: f(3) };
        case "Color":
            return { r: f(0), g: f(1), b: f(2), a: f(3, 255) };
        case "LinearColor":
            return { r: f(0), g: f(1), b: f(2), a: f(3, 1) };
        case "Transform":
            return {
                translation: { x: f(0), y: f(1), z: f(2) },
                rotation: { x: f(3), y: f(4), z: f(5), w: f(6, 1) },
                scale3D: { x: f(7, 1), y: f(8, 1), z: f(9, 1) }
            };
        case "Guid":
            return String(raw || "").replace(/[^0-9a-fA-F]/g, "");
        default:
            return null;
    }
}

function dfDefaultValueLabel(def) {
    switch (def.kind) {
        case "bool": return "false";
        case "num": return "0";
        case "str": return "";
        case "name": return "None";
        case "text": return "";
        case "objidx": return "0";
        case "lazy": return "00000000000000000000000000000000";
        case "softobj": return "None";
        case "byte": return "0";
        case "enum": return "None";
        case "hex": return "";
        case "struct":
            if (def.struct === "LinearColor") return "0,0,0,1";
            if (def.struct === "Quat" || def.struct === "Vector4") return "0,0,0,1";
            if (def.struct === "Color") return "255,255,255,255";
            if (def.struct === "Transform") return "0,0,0,0,0,0,1,1,1,1";
            if (def.struct === "Guid") return "00000000000000000000000000000000";
            if (def.struct === "Vector" || def.struct === "Rotator") return "0,0,0";
            return "0,0";
    }
    return "";
}

function dfBuildProperty(name, typeLabel, rawValue) {
    var def = dfFindTypeDef(typeLabel);
    var prop = {
        name: name,
        type: def.ptype,
        value: 0,
        arrayIndex: 0,
        isModified: true,
        originalBytes: null
    };
    if (def.struct) prop.structName = def.struct;
    switch (def.kind) {
        case "bool":
            prop.value = (rawValue === true || rawValue === "true" || rawValue === 1);
            break;
        case "num":
            var rawNum = String(rawValue === undefined || rawValue === "" ? "0" : rawValue).trim();
            if (def.ptype === "Int64Property" || def.ptype === "UInt64Property") {
                prop.value = rawNum;
            } else {
                var parsedNum = Number(rawNum);
                prop.value = isFinite(parsedNum) ? parsedNum : 0;
            }
            break;
        case "str":
            prop.value = String(rawValue === undefined ? "" : rawValue);
            break;
        case "name":
            prop.value = String(rawValue === undefined || rawValue === "" ? "None" : rawValue);
            break;
        case "text":
            prop.value = { flags: 0, historyType: 0, namespace: "", key: "", sourceString: String(rawValue === undefined ? "" : rawValue) };
            break;
        case "objidx":
            prop.value = Number(rawValue) || 0;
            prop.rawIndex = Number(rawValue) || 0;
            break;
        case "lazy":
            var lazyBytes = dfHexToBytes(rawValue);
            if (lazyBytes.length !== 16) {
                lazyBytes = new Uint8Array(16);
            }
            prop.value = lazyBytes;
            break;
        case "softobj":
            prop.value = { assetPathName: String(rawValue === undefined || rawValue === "" ? "None" : rawValue), subPathString: "" };
            break;
        case "byte":
            var byteStr = String(rawValue === undefined ? "0" : rawValue).trim();
            if (isFinite(Number(byteStr)) && byteStr !== "") {
                prop.value = Number(byteStr) & 0xFF;
            } else {
                prop.value = byteStr;
            }
            break;
        case "enum":
            prop.value = String(rawValue === undefined || rawValue === "" ? "None" : rawValue);
            break;
        case "hex":
            prop.value = dfHexToBytes(rawValue);
            break;
        case "struct":
            prop.value = dfParseStruct(def.struct, rawValue);
            break;
    }
    return prop;
}

/* ---------- 表格最后一行入口 ---------- */
function appendInsertPropertyRow(properties, currentExport) {
    if (!properties) return;
    dfInjectInsertStyles();
    var tbl = document.getElementById("propertyTable");
    var cols = tbl && tbl.tHead ? tbl.tHead.rows[0].cells.length : 5;
    var tr = document.createElement("tr");
    tr.className = "df-insert-row";
    var tdP = document.createElement("td");
    tdP.className = "df-ins-plus";
    tdP.textContent = "+";
    tr.appendChild(tdP);
    var tdN = document.createElement("td");
    tdN.className = "df-ins-label";
    tdN.textContent = "插入新属性...";
    tr.appendChild(tdN);
    for (var i = 2; i < cols; i++) tr.appendChild(document.createElement("td"));
    tr.onclick = function () { openInsertPropertyDialog(properties, currentExport); };
    tableBody.appendChild(tr);
}

/* ---------- 弹窗 ---------- */
function dfInjectInsertStyles() {
    if (document.getElementById("dfInsertStyles")) return;
    var style = document.createElement("style");
    style.id = "dfInsertStyles";
    style.textContent = [
"#dfInsertOverlay { padding: 14px; }",
        "#dfInsertOverlay .settings-modal { width: min(86vw, 352px); max-width: none; border-radius: 20px; border: 1px solid var(--border-color); box-shadow: 0 24px 60px rgba(0,0,0,.28); overflow: hidden; background: var(--bg-dark) !important; }",
        "#dfInsertOverlay .settings-header { padding: 16px 18px 6px; border-bottom: none; }",
        "#dfInsertOverlay .settings-header h2 { font-size: 17px; font-weight: 700; letter-spacing: .2px; color: var(--btn-save) !important; }",
        "#dfInsertOverlay #dfInsertOverlay .settings-close { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: var(--btn-bg); color: var(--text-dim); }",
        "#dfInsertOverlay .settings-content { padding: 2px 18px 18px; overflow: visible; }",
        "#dfInsertOverlay .df-field { margin-bottom: 13px; }",
        "#dfInsertOverlay .df-field > label { display: block; font-size: 12px; font-weight: 600; color: var(--text-dim); margin-bottom: 8px; letter-spacing: .4px; }",
        "#dfInsertOverlay .df-input, #dfInsertOverlay .df-select, #dfInsertOverlay .df-textarea { width: 100%; padding: 11px 13px; border-radius: 11px; background: var(--bg-dark); color: var(--text-main); border: 1.5px solid var(--border-color); font-size: 14px; outline: none; font-family: inherit; transition: border-color .15s, box-shadow .15s; }",
        "#dfInsertOverlay .df-input:focus, #dfInsertOverlay .df-select:focus, #dfInsertOverlay .df-textarea:focus { border-color: var(--btn-save); box-shadow: 0 0 0 3px rgba(46,180,110,.16); }",
        "#dfInsertOverlay .df-textarea { min-height: 80px; resize: vertical; font-family: monospace; }",
        "#dfInsertOverlay .df-select { appearance: none; -webkit-appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--text-dim) 50%), linear-gradient(135deg, var(--text-dim) 50%, transparent 50%); background-position: calc(100% - 19px) 50%, calc(100% - 14px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 38px; }",
        "#dfInsertOverlay .df-hint { font-size: 11.5px; color: var(--text-dim); margin-top: 8px; opacity: .75; line-height: 1.5; }",
        "#dfInsertOverlay .df-row { display: flex; gap: 10px; }",
        "#dfInsertOverlay .df-cell { flex: 1 1 0; min-width: 0; }",
        "#dfInsertOverlay .df-actions { display: flex; gap: 10px; margin-top: 18px; }",
        "#dfInsertOverlay .df-btn { flex: 1; height: 42px; border-radius: 12px; border: none; font-size: 14.5px; font-weight: 600; font-family: inherit; cursor: pointer; transition: transform .12s, opacity .12s; }",
        "#dfInsertOverlay .df-btn:active { transform: scale(.98); }",
        "#dfInsertOverlay .df-btn.cancel { background: var(--btn-bg); color: var(--text-main); }",
        "#dfInsertOverlay .df-btn.ok { background: var(--btn-save); color: #fff; box-shadow: 0 8px 20px rgba(46,180,110,.28); }",
        ".df-insert-row td { background: transparent; border-top: 1px solid var(--border-color); padding: 4px 6px; cursor: pointer; }",
        ".df-insert-row .df-ins-plus { color: var(--btn-save) !important; font-weight: 600; font-size: 15px; text-align: center; line-height: 19px; }",
        ".df-insert-row .df-ins-label { color: var(--text-dim) !important; font-style: italic; font-size: 13px; line-height: 19px; }",
        ".df-selbar .df-selcount { font-size: 13px; color: var(--text-dim); margin-right: auto; font-weight: 500; }",
        ".df-selbar button { border: none; background: transparent; font-size: 13px; color: var(--text-main); padding: 6px 8px; border-radius: 8px; font-family: inherit; }",
        ".df-selbar button.del { color: #e5484d; font-weight: 600; background: rgba(229,72,77,.09); padding: 6px 12px; }",
        ".df-selbar button:active { opacity: .6; }",
        "tr.df-copied { background: rgba(76,175,80,.18) !important; }",
        ".insert-prop-row:active td { opacity: .5; }"
    ].join("\n");
    document.head.appendChild(style);
}

function dfEnsureDialog() {
    var old = document.getElementById("dfInsertOverlay");
    if (old) old.remove();
    dfInjectInsertStyles();
    var html = ''
        + '<div class="settings-overlay" id="dfInsertOverlay">'
        + '  <div class="settings-modal">'
        + '    <div class="settings-header"><h2>插入新属性</h2>'
        + '      <button class="settings-close" id="dfInsClose">'
        + '        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
        + '      </button>'
        + '    </div>'
        + '    <div class="settings-content">'
        + '      <div class="df-field"><label>插入位置（默认：导出末尾）</label>'
        + '        <select class="df-select" id="dfInsPos"></select></div>'
        + '      <div class="df-field"><label>属性名</label>'
        + '        <input class="df-input" id="dfInsName" placeholder="例如：MyProperty" autocomplete="off">'
        + '</div>'
        + '      <div class="df-field"><label>类型</label>'
        + '        <select class="df-select" id="dfInsType"></select></div>'
        + '      <div class="df-field"><label>属性值</label>'
        + '        <div id="dfInsValueHost"></div>'
        + '        <div class="df-hint" id="dfInsHint"></div></div>'
        + '      <div class="df-actions">'
        + '        <button class="df-btn cancel" id="dfInsCancel">取消</button>'
        + '        <button class="df-btn ok" id="dfInsOk">插入</button>'
        + '      </div>'
        + '    </div>'
        + '  </div>'
        + '</div>';
    document.body.insertAdjacentHTML("beforeend", html);
    return document.getElementById("dfInsertOverlay");
}

function dfCollectValue() {
    var parts = document.querySelectorAll("#dfInsValueHost .df-part");
    if (parts.length) {
        var vals = [];
        for (var i = 0; i < parts.length; i++) vals.push(parts[i].value.trim() || "0");
        return vals.join(",");
    }
    var el = document.getElementById("dfInsValue");
    return el ? el.value : "";
}
function dfRenderValueControl(def) {
    var host0 = document.getElementById("dfInsValueHost");
    var FIELD_MAP = {Vector:["X","Y","Z"],Rotator:["Pitch","Yaw","Roll"],Vector2D:["X","Y"],Quat:["X","Y","Z","W"],Vector4:["X","Y","Z","W"],Plane:["X","Y","Z","W"],Color:["R","G","B","A"],LinearColor:["R","G","B","A"],IntPoint:["X","Y"],Transform:["PX","PY","PZ","QX","QY","QZ","QW","SX","SY","SZ"]};
    if (def.kind === "struct" && FIELD_MAP[def.struct] && host0) {
        var fields0 = FIELD_MAP[def.struct];
        var dp = String(dfDefaultValueLabel(def) || "").split(",");
        host0.innerHTML = "";
        var row0 = document.createElement("div");
        row0.className = "df-row";
        fields0.forEach(function (fn, fi) {
            var cell = document.createElement("div");
            cell.className = "df-cell";
            var ip = document.createElement("input");
            ip.className = "df-input df-part";
            ip.type = "text";
            ip.value = (dp[fi] === undefined || dp[fi] === "" ? "0" : dp[fi]);
            cell.appendChild(ip);
            row0.appendChild(cell);
        });
        host0.appendChild(row0);
        var h0 = document.getElementById("dfInsHint");
        if (h0) h0.textContent = def.hint || "";
        return;
    }

    var host = document.getElementById("dfInsValueHost");
    var hint = document.getElementById("dfInsHint");
    if (!host) return;
    host.innerHTML = "";
    if (hint) hint.textContent = def.hint || "";
    if (def.kind === "bool") {
        var sel = document.createElement("select");
        sel.className = "df-select";
        sel.id = "dfInsValue";
        ["true", "false"].forEach(function (v) {
            var o = document.createElement("option");
            o.value = v;
            o.textContent = v;
            sel.appendChild(o);
        });
        host.appendChild(sel);
        return;
    }
    if (def.kind === "hex") {
        var ta = document.createElement("textarea");
        ta.className = "df-textarea";
        ta.id = "dfInsValue";
        ta.placeholder = "例如：00 00 80 3F 00 00 00 00";
        host.appendChild(ta);
        return;
    }
    var input = document.createElement("input");
    input.className = "df-input";
    input.id = "dfInsValue";
    input.type = "text";
    input.value = dfDefaultValueLabel(def);
    input.placeholder = def.hint || "输入值";
    if (def.kind === "name") {
    }
    host.appendChild(input);
}

function openInsertPropertyDialog(properties, currentExport) {
    if (!currentExport || !properties) {
        showToast("请先选择一个导出");
        return;
    }
    dfEnsureDialog();

    var posSel = document.getElementById("dfInsPos");
    var typeSel = document.getElementById("dfInsType");

    posSel.innerHTML = "";
    var optEnd = document.createElement("option");
    optEnd.value = "end";
    optEnd.textContent = "自动插入到导出末尾 (推荐)";
    posSel.appendChild(optEnd);
    for (var i = 0; i < properties.length; i++) {
        var p = properties[i];
        if (!p || !p.name) continue;
        var o = document.createElement("option");
        o.value = String(i);
        o.textContent = '在 "' + p.name + '" (' + (p.type || "?") + ') 后面插入';
        posSel.appendChild(o);
    }
    posSel.value = "end";

    typeSel.innerHTML = "";
    DF_TYPE_DEFS.forEach(function (d) {
        var o = document.createElement("option");
        o.value = d.id;
        o.textContent = d.id;
        typeSel.appendChild(o);
    });
    typeSel.value = DF_TYPE_DEFS[0].id;

    dfRenderValueControl(dfFindTypeDef(typeSel.value));
    typeSel.onchange = function () {
        dfRenderValueControl(dfFindTypeDef(typeSel.value));
    };

    var overlay = document.getElementById("dfInsertOverlay");
    overlay.classList.add("active");
    overlay.style.display = "flex";

    function close() {
        overlay.classList.remove("active");
        overlay.style.display = "none";
        overlay.remove();
    }

    document.getElementById("dfInsClose").onclick = close;
    document.getElementById("dfInsCancel").onclick = close;
    overlay.onclick = function (e) {
        if (e.target === overlay) close();
    };

    document.getElementById("dfInsOk").onclick = function () {
        var nameInput = document.getElementById("dfInsName");
        var valueInput = document.getElementById("dfInsValue");
        var name = (nameInput.value || "").trim();
        if (!name) {
            showToast("请填写属性名");
            return;
        }
        if (/[\s"'<>|]/.test(name)) {
            showToast("属性名不能包含空格或引号");
            return;
        }
        var def = dfFindTypeDef(typeSel.value);
        var raw = dfCollectValue();
        var prop = dfBuildProperty(name, typeSel.value, raw);

        // 名称表：属性名 / 类型名 / 结构名 / None 必须存在
        var needNames = ["None", prop.type];
        if (prop.structName) needNames.push(prop.structName);
        if (prop.enumName) needNames.push(prop.enumName);
        needNames.forEach(function (nn) {
            if (!nn) return;
            if (globalNameMap.indexOf(nn) === -1) {
                ensureNameInMap(nn);
                nameMapNeedsGrow = true;
            }
        });
        if (globalNameMap.indexOf(name) === -1) {
            ensureNameInMap(name);
            nameMapNeedsGrow = true;
        }

        var insertAt = properties.length;
        if (posSel.value !== "end") {
            var at = parseInt(posSel.value, 10);
            if (!isNaN(at)) insertAt = Math.min(properties.length, at + 1);
        }

        // 插入点不在导出根层时，父级原始字节必须失效，否则新属性写不进去
        if (currentExport.properties && properties !== currentExport.properties) {
            dfClearRawDeep(currentExport.properties);
        }

        properties.splice(insertAt, 0, prop);
        currentExport.isModified = true;

        var listItem = document.getElementById("export-" + globalExports.indexOf(currentExport));
        if (listItem) listItem.style.color = "#4CAF50";

        debugLog("[INSERT] 新属性 '" + name + "' (" + prop.type + (prop.structName ? "/" + prop.structName : "") + ") 插入到索引 " + insertAt + "，共 " + properties.length + " 项");
        close();
        showToast("已插入，保存后写入文件");

        renderTable(properties, lastRenderedHeaderData, currentExport, lastRenderedParentArray);
    };
}

function dfClearRawDeep(props) {
    if (!Array.isArray(props)) return;
    for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (!p || typeof p !== "object") continue;
        p.originalBytes = null;
        p.isModified = true;
        if (p.value && typeof p.value === "object") {
            if (p.value._rawBytes) p.value._rawBytes = null;
            if (Array.isArray(p.value)) dfClearRawDeep(p.value);
        }
    }
    if (props._rawBytes) props._rawBytes = null;
}

/* ---------- 名称表扩容（整体重编码 + 后续表整体后移） ---------- */
function dfNameMapEndOffset(bytes, nameOffset, count, hasHash) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = nameOffset;
    for (var i = 0; i < count; i++) {
        var len = view.getInt32(pos, true);
        pos += 4;
        var bodyLen = len < 0 ? -len * 2 : len;
        pos += bodyLen;
        if (hasHash) pos += 4;
    }
    return pos;
}

function dfEncodeNameEntry(name, hasHash, hashVal) {
    var ascii = /^[\x00-\x7F]*$/.test(name);
    var bodyLen = ascii ? name.length + 1 : (name.length + 1) * 2;
    var out = new Uint8Array(4 + bodyLen + (hasHash ? 4 : 0));
    var view = new DataView(out.buffer);
    if (ascii) {
        view.setInt32(0, name.length + 1, true);
        for (var i = 0; i < name.length; i++) out[4 + i] = name.charCodeAt(i) & 0xFF;
        out[4 + name.length] = 0;
    } else {
        view.setInt32(0, -(name.length + 1), true);
        var p = 4;
        for (var j = 0; j < name.length; j++) {
            var code = name.charCodeAt(j);
            out[p++] = code & 0xFF;
            out[p++] = (code >> 8) & 0xFF;
        }
        out[p++] = 0;
        out[p++] = 0;
    }
    if (hasHash) view.setUint32(4 + bodyLen, (hashVal === null || hashVal === undefined) ? 0 : (hashVal >>> 0), true);
    return out;
}

function growUAssetNameMap(enableDebug) {
    if (!globalHeader || !globalUAssetBuffer || !originalNameMap || !globalNameMap) {
        debugError("[NAME_GROW] 缺少重建所需数据");
        return null;
    }
    var header = globalHeader;
    var oldBytes = globalUAssetBuffer instanceof Uint8Array
        ? globalUAssetBuffer
        : new Uint8Array(globalUAssetBuffer);
    var nameOffset = header.nameOffset;
    var hasHash = header.fileVersionUE4 >= 504;
    var oldCount = header.nameCount;
    var mapEnd = dfNameMapEndOffset(oldBytes, nameOffset, oldCount, hasHash);

    // 预扫描原名称表，记录每条原始字节范围
    var view0 = new DataView(oldBytes.buffer, oldBytes.byteOffset, oldBytes.byteLength);
    var oldSpans = [];
    var q0 = nameOffset;
    for (var si = 0; si < oldCount; si++) {
        var st0 = q0;
        var l0 = view0.getInt32(q0, true); q0 += 4;
        q0 += (l0 < 0 ? -l0 * 2 : l0);
        if (hasHash) q0 += 4;
        oldSpans.push([st0, q0]);
    }

    // 未改名的条目直接复制原始字节（保留原 hash / 编码），改名或新增的才重新编码
    var entries = [];
    var newMapLen = 0;
    for (var i = 0; i < globalNameMap.length; i++) {
        var e;
        if (i < oldCount && globalNameMap[i] === originalNameMap[i]) {
            e = oldBytes.subarray(oldSpans[i][0], oldSpans[i][1]);
        } else {
            var newHash = hasHash ? dfNameHash(globalNameMap[i] || "") : null;
            e = dfEncodeNameEntry(globalNameMap[i] || "", hasHash, newHash);
        }
        entries.push(e);
        newMapLen += e.length;
    }

    // 不做额外对齐：只有变短时才补 0 到原长度，保持结构完全不变
    var origMapLen = mapEnd - nameOffset;
    if (newMapLen < origMapLen) {
        entries.push(new Uint8Array(origMapLen - newMapLen));
        newMapLen = origMapLen;
    }
    var delta = newMapLen - origMapLen;
    var tail = oldBytes.subarray(mapEnd);
    var outBytes = new Uint8Array(nameOffset + newMapLen + tail.length);
    outBytes.set(oldBytes.subarray(0, nameOffset), 0);
    var p = nameOffset;
    for (var k = 0; k < entries.length; k++) {
        outBytes.set(entries[k], p);
        p += entries[k].length;
    }
    outBytes.set(tail, nameOffset + newMapLen);

    var view = new DataView(outBytes.buffer);
    var updated = Object.assign({}, header);
    updated.nameCount = globalNameMap.length;
    updated.totalHeaderSize = header.totalHeaderSize + delta;

    // 所有位于名称表之后的绝对偏移整体后移
    var positions = header.offsetPositions || {};
    var shifted = {};
    Object.keys(positions).forEach(function (key) {
        var fieldPos = positions[key];
        if (typeof fieldPos !== "number") return;
        if (key === "nameOffset" || key === "totalHeaderSize") return;
        if (fieldPos + 4 > outBytes.length) return;
        var val = view.getInt32(fieldPos, true);
        if (val >= mapEnd && val !== 0) {
            view.setInt32(fieldPos, val + delta, true);
            shifted[key] = val + delta;
        }
    });
    Object.keys(shifted).forEach(function (key) {
        updated[key] = shifted[key];
    });

    // totalHeaderSize 字段
    if (typeof positions.totalHeaderSize === "number") {
        view.setInt32(positions.totalHeaderSize, updated.totalHeaderSize, true);
    }
    // nameCount 字段位于 nameOffset 字段前 4 字节
    if (typeof positions.nameOffset === "number") {
        view.setInt32(positions.nameOffset - 4, globalNameMap.length, true);
    }

    if (enableDebug) {
        debugLog("[NAME_GROW] 名称表 " + oldCount + " -> " + globalNameMap.length + " 项，大小 " + (mapEnd - nameOffset) + " -> " + newMapLen + " 字节，delta=" + delta);
        debugLog("[NAME_GROW] 新 totalHeaderSize=" + updated.totalHeaderSize + "，已后移字段：" + Object.keys(shifted).join(","));
    }

    return { buffer: outBytes.buffer, updatedHeader: updated, delta: delta };
}

/* ---------- 导出表校正：写入新的 serialSize / serialOffset ---------- */
function patchExportTableForNewOffsets(uassetBuffer, exportOffsets) {
    if (!globalHeader || !globalExports || !globalExports.length) return uassetBuffer;
    var src = uassetBuffer instanceof Uint8Array ? uassetBuffer : new Uint8Array(uassetBuffer);
    var outBytes = new Uint8Array(src.length);
    outBytes.set(src);
    var view = new DataView(outBytes.buffer);
    var ver = globalHeader.fileVersionUE4;
    var is64 = ver >= 508;
    var entrySize = 28 + (is64 ? 16 : 8) + 12 + 16 + 4
        + (ver >= 365 ? 4 : 0)
        + (ver >= 465 ? 4 : 0)
        + (ver >= 507 ? 20 : 0);
    var pos = globalHeader.exportOffset;
    var changed = 0;

    for (var i = 0; i < globalExports.length; i++) {
        var exp = globalExports[i];
        var rec = exportOffsets && exportOffsets.get ? exportOffsets.get(i) : null;
        // 读取失败会记 size:0，此时保留原值，避免把有内容的导出清零
        if (rec && rec.size === 0 && exp.serialSize > 0) rec = null;
        var newSize = rec ? rec.size : exp.serialSize;
        var newOffset = exp.serialOffset;
        // 只有 .uexp 分离的文件，serialOffset 才以 totalHeaderSize 为基准重算
        if (rec && globalUExpBuffer) {
            newOffset = globalHeader.totalHeaderSize + rec.offset;
        }
        if (newSize !== exp.serialSize || newOffset !== exp.serialOffset) changed++;
        exp.serialSize = newSize;
        exp.serialOffset = newOffset;
        if (pos + entrySize > outBytes.length) break;
        if (is64) {
            view.setBigInt64(pos + 28, BigInt(Math.floor(newSize)), true);
            view.setBigInt64(pos + 36, BigInt(Math.floor(newOffset)), true);
        } else {
            view.setInt32(pos + 28, newSize | 0, true);
            view.setInt32(pos + 32, newOffset | 0, true);
        }
        pos += entrySize;
    }
    debugLog("[EXPORT_TABLE] 校正 " + globalExports.length + " 条导出，变更 " + changed + " 条");
    return outBytes.buffer;
}

var dfSelMode = false;
var dfSelSet = new Set();
var dfSelProps = null;
var dfSelExport = null;
function dfSelInjectStyle() {
    if (document.getElementById("dfSelStyle")) return;
    var st = document.createElement("style");
    st.id = "dfSelStyle";
    st.textContent = [
        ".table-header-tools { position: relative; }",
        ".df-selbar { position: absolute; inset: 0; display: flex; align-items: center; gap: 10px; padding: 0 12px; background: var(--bg-dark, #fff); z-index: 6; }",
        ".df-selbar .df-selcount { font-size: 13px; color: var(--text-dim); margin-right: auto; }",
        ".df-selbar button { border: none; background: transparent; font-size: 13px; color: var(--text-main); padding: 6px 4px; }",
        ".df-selbar button.del { color: #e5484d; font-weight: 600; }",
        ".df-check { display: inline-flex; width: 15px; height: 15px; border-radius: 50%; border: 1.5px solid #c9c9c9; margin-right: 6px; vertical-align: -2px; box-sizing: border-box; align-items: center; justify-content: center; font-size: 10px; color: #fff; }",
        "tr.df-on { background: #fff2f2 !important; }",
        "tr.df-on .df-check { background: #34c759; border-color: #34c759; }",
        "tr.df-on .df-check::after { content: \"\\2713\"; }"
    ].join(" ");
    document.head.appendChild(st);
}
function dfRenderSelBar() {
    var tools = document.querySelector(".table-header-tools");
    if (!tools) return;
    var bar = tools.querySelector(".df-selbar");
    if (!dfSelMode) { if (bar) bar.remove(); return; }
    dfSelInjectStyle();
    if (!bar) { bar = document.createElement("div"); bar.className = "df-selbar"; tools.appendChild(bar); }
    var n = dfSelSet.size;
    bar.innerHTML = "<span class=df-selcount>已选 " + n + " 项</span>"
        + "<button id=dfSelAll>全选</button>"
        + "<button id=dfSelCancel>取消</button>"
        + "<button id=dfSelDel class=del>删除 (" + n + ")</button>";
    bar.querySelector("#dfSelAll").onclick = dfSelectAll;
    bar.querySelector("#dfSelCancel").onclick = dfExitSelect;
    bar.querySelector("#dfSelDel").onclick = dfDeleteSelected;
}
function dfSyncRows() {
    var rows = tableBody.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i], pr = r.__dfProp;
        if (!pr) continue;
        r.classList.toggle("df-on", dfSelMode && dfSelSet.has(pr));
        var td = r.cells[0];
        if (!td) continue;
        var ck = td.querySelector(".df-check");
        if (dfSelMode) {
            if (!ck) { ck = document.createElement("span"); ck.className = "df-check"; td.insertBefore(ck, td.firstChild); }
        } else if (ck) { ck.remove(); }
    }
}
function dfEnterSelect(props, exp, pr) {
    dfSelMode = true; dfSelProps = props; dfSelExport = exp;
    dfSelSet.clear();
    if (pr) dfSelSet.add(pr);
    dfSyncRows(); dfRenderSelBar();
}
function dfDecorateRows(props, exp) {
    dfSelInjectStyle();
    if (dfSelMode && dfSelProps !== props) { dfSelMode = false; dfSelSet.clear(); }
    var rows = tableBody.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) (function (row) {
        var pr = row.__dfProp;
        if (!pr || row.__dfBound) return;
        row.__dfBound = true;
        var sx = 0, sy = 0, tracking = false, moved = false, lpTimer = null;
        row.addEventListener("touchstart", function (e) {
            if (dfSelMode) return;
            var t = e.touches[0]; sx = t.clientX; sy = t.clientY; tracking = true; moved = false;
            if (lpTimer) clearTimeout(lpTimer);
            lpTimer = setTimeout(function () {
                lpTimer = null; tracking = false;
                dfCopyRow(row);
            }, 550);
        }, { passive: true });
        row.addEventListener("touchmove", function (e) {
            if (!tracking) return;
            var t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
            if (lpTimer && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { clearTimeout(lpTimer); lpTimer = null; }
            if (dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) {
                moved = true;
                row.style.transform = "translateX(" + Math.min(dx * 0.45, 70) + "px)";
            }
        }, { passive: true });
        row.addEventListener("touchend", function (e) {
            if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
            row.style.transform = "";
            if (!tracking) return;
            tracking = false;
            var t = e.changedTouches[0], dx = t.clientX - sx;
            if (moved && dx > 55) { dfEnterSelect(props, exp, pr); if (e.preventDefault) e.preventDefault(); }
        });
        row.addEventListener("contextmenu", function (e) {
            e.preventDefault();
            dfCopyRow(row);
        });
        row.addEventListener("click", function (e) {
            if (!dfSelMode) return;
            e.preventDefault(); e.stopPropagation();
            if (dfSelSet.has(pr)) dfSelSet.delete(pr); else dfSelSet.add(pr);
            if (dfSelSet.size === 0) { dfExitSelect(); return; }
            dfSyncRows(); dfRenderSelBar();
        }, true);
    })(rows[i]);
    dfSyncRows();
    dfRenderSelBar();
}
function dfSelectAll() {
    var props = dfSelProps || [];
    dfSelSet.clear();
    for (var i = 0; i < props.length; i++) { if (props[i]) dfSelSet.add(props[i]); }
    dfSyncRows(); dfRenderSelBar();
}
function dfExitSelect() {
    dfSelMode = false; dfSelSet.clear();
    dfSyncRows(); dfRenderSelBar();
}
function dfDeleteSelected() {
    var props = dfSelProps, exp = dfSelExport;
    if (!props || !exp) { dfExitSelect(); return; }
    var list = [];
    for (var i = 0; i < props.length; i++) { if (dfSelSet.has(props[i])) list.push(props[i]); }
    if (!list.length) { dfExitSelect(); return; }
    if (props !== exp.properties) dfClearRawDeep(exp.properties);
    for (var j = 0; j < list.length; j++) {
        var k = props.indexOf(list[j]);
        if (k >= 0) props.splice(k, 1);
    }
    exp.isModified = true; exp.__dfDeleted = true;
    var n = list.length;
    dfSelMode = false; dfSelSet.clear();
    renderTable(props, lastRenderedHeaderData, exp, lastRenderedParentArray);
    dfRenderSelBar();
    if (typeof showToast === "function") showToast("已删除 " + n + " 个属性");
}

/* ---------- 保存后回读校验（静默，仅在失败时提示） ---------- */
function dfVerifySaved(uassetBuf, uexpBuf) {
    try {
        if (uassetBuf instanceof Uint8Array) {
            uassetBuf = uassetBuf.buffer.slice(uassetBuf.byteOffset, uassetBuf.byteOffset + uassetBuf.byteLength);
        }
        if (uexpBuf instanceof Uint8Array) {
            uexpBuf = uexpBuf.buffer.slice(uexpBuf.byteOffset, uexpBuf.byteOffset + uexpBuf.byteLength);
        }
        var hr = new UAssetHeaderReader(uassetBuf);
        var hdr = hr.read();
        if (!hdr) return "header 解析失败";
        var ths = hdr.totalHeaderSize;
        var uexpLen = uexpBuf ? uexpBuf.byteLength : 0;
        var nmr = new UAssetNameMapReader(uassetBuf, hdr.fileVersionUE4);
        var endOff = hdr.importOffset > 0 ? hdr.importOffset : hdr.exportOffset;
        var names = nmr.read(hdr.nameOffset, hdr.nameCount, endOff);
        if (names.length !== hdr.nameCount) {
            return "名称表残缺 " + names.length + "/" + hdr.nameCount;
        }
        var exps = (typeof globalExports !== "undefined" && globalExports) ? globalExports : null;
        if (!exps || exps.length === 0) return "导出表为空";
        var bad = [];
        for (var i = 0; i < exps.length; i++) {
            var e = exps[i];
            if (!e || e.serialSize <= 0) continue;
            var rel = e.serialOffset - ths;
            if (rel < 0) { bad.push(i + ":offset<header"); continue; }
            if (uexpLen > 0 && rel + e.serialSize > uexpLen) {
                bad.push(i + ":越界");
            }
        }
        if (bad.length > 0) {
            return "导出越界 " + bad.length + " 条 (" + bad.slice(0, 3).join(",") + ")";
        }
        debugLog("[VERIFY] ok: " + exps.length + " exports, " + names.length + " names, ths=" + ths);
        return null;
    } catch (e) {
        return e.message;
    }
}

/* ---------- CRC32（用于改名后的名称 hash） ---------- */
var DF_CRC_TABLE = null;
function dfCrc32(str) {
    if (!DF_CRC_TABLE) {
        DF_CRC_TABLE = new Int32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i;
            for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            DF_CRC_TABLE[i] = c;
        }
    }
    var crc = -1;
    for (var k = 0; k < str.length; k++) {
        crc = (crc >>> 8) ^ DF_CRC_TABLE[(crc ^ str.charCodeAt(k)) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
}

/* ---------- UE NameMap hash (UAssetAPI/UE4 实现) ---------- */
var DF_DEP_TABLE = [0x00000000,0x04C11DB7,0x09823B6E,0x0D4326D9,0x130476DC,0x17C56B6B,0x1A864DB2,0x1E475005,0x2608EDB8,0x22C9F00F,0x2F8AD6D6,0x2B4BCB61,0x350C9B64,0x31CD86D3,0x3C8EA00A,0x384FBDBD,0x4C11DB70,0x48D0C6C7,0x4593E01E,0x4152FDA9,0x5F15ADAC,0x5BD4B01B,0x569796C2,0x52568B75,0x6A1936C8,0x6ED82B7F,0x639B0DA6,0x675A1011,0x791D4014,0x7DDC5DA3,0x709F7B7A,0x745E66CD,0x9823B6E0,0x9CE2AB57,0x91A18D8E,0x95609039,0x8B27C03C,0x8FE6DD8B,0x82A5FB52,0x8664E6E5,0xBE2B5B58,0xBAEA46EF,0xB7A96036,0xB3687D81,0xAD2F2D84,0xA9EE3033,0xA4AD16EA,0xA06C0B5D,0xD4326D90,0xD0F37027,0xDDB056FE,0xD9714B49,0xC7361B4C,0xC3F706FB,0xCEB42022,0xCA753D95,0xF23A8028,0xF6FB9D9F,0xFBB8BB46,0xFF79A6F1,0xE13EF6F4,0xE5FFEB43,0xE8BCCD9A,0xEC7DD02D,0x34867077,0x30476DC0,0x3D044B19,0x39C556AE,0x278206AB,0x23431B1C,0x2E003DC5,0x2AC12072,0x128E9DCF,0x164F8078,0x1B0CA6A1,0x1FCDBB16,0x018AEB13,0x054BF6A4,0x0808D07D,0x0CC9CDCA,0x7897AB07,0x7C56B6B0,0x71159069,0x75D48DDE,0x6B93DDDB,0x6F52C06C,0x6211E6B5,0x66D0FB02,0x5E9F46BF,0x5A5E5B08,0x571D7DD1,0x53DC6066,0x4D9B3063,0x495A2DD4,0x44190B0D,0x40D816BA,0xACA5C697,0xA864DB20,0xA527FDF9,0xA1E6E04E,0xBFA1B04B,0xBB60ADFC,0xB6238B25,0xB2E29692,0x8AAD2B2F,0x8E6C3698,0x832F1041,0x87EE0DF6,0x99A95DF3,0x9D684044,0x902B669D,0x94EA7B2A,0xE0B41DE7,0xE4750050,0xE9362689,0xEDF73B3E,0xF3B06B3B,0xF771768C,0xFA325055,0xFEF34DE2,0xC6BCF05F,0xC27DEDE8,0xCF3ECB31,0xCBFFD686,0xD5B88683,0xD1799B34,0xDC3ABDED,0xD8FBA05A,0x690CE0EE,0x6DCDFD59,0x608EDB80,0x644FC637,0x7A089632,0x7EC98B85,0x738AAD5C,0x774BB0EB,0x4F040D56,0x4BC510E1,0x46863638,0x42472B8F,0x5C007B8A,0x58C1663D,0x558240E4,0x51435D53,0x251D3B9E,0x21DC2629,0x2C9F00F0,0x285E1D47,0x36194D42,0x32D850F5,0x3F9B762C,0x3B5A6B9B,0x0315D626,0x07D4CB91,0x0A97ED48,0x0E56F0FF,0x1011A0FA,0x14D0BD4D,0x19939B94,0x1D528623,0xF12F560E,0xF5EE4BB9,0xF8AD6D60,0xFC6C70D7,0xE22B20D2,0xE6EA3D65,0xEBA91BBC,0xEF68060B,0xD727BBB6,0xD3E6A601,0xDEA580D8,0xDA649D6F,0xC423CD6A,0xC0E2D0DD,0xCDA1F604,0xC960EBB3,0xBD3E8D7E,0xB9FF90C9,0xB4BCB610,0xB07DABA7,0xAE3AFBA2,0xAAFBE615,0xA7B8C0CC,0xA379DD7B,0x9B3660C6,0x9FF77D71,0x92B45BA8,0x9675461F,0x8832161A,0x8CF30BAD,0x81B02D74,0x857130C3,0x5D8A9099,0x594B8D2E,0x5408ABF7,0x50C9B640,0x4E8EE645,0x4A4FFBF2,0x470CDD2B,0x43CDC09C,0x7B827D21,0x7F436096,0x7200464F,0x76C15BF8,0x68860BFD,0x6C47164A,0x61043093,0x65C52D24,0x119B4BE9,0x155A565E,0x18197087,0x1CD86D30,0x029F3D35,0x065E2082,0x0B1D065B,0x0FDC1BEC,0x3793A651,0x3352BBE6,0x3E119D3F,0x3AD08088,0x2497D08D,0x2056CD3A,0x2D15EBE3,0x29D4F654,0xC5A92679,0xC1683BCE,0xCC2B1D17,0xC8EA00A0,0xD6AD50A5,0xD26C4D12,0xDF2F6BCB,0xDBEE767C,0xE3A1CBC1,0xE760D676,0xEA23F0AF,0xEEE2ED18,0xF0A5BD1D,0xF464A0AA,0xF9278673,0xFDE69BC4,0x89B8FD09,0x8D79E0BE,0x803AC667,0x84FBDBD0,0x9ABC8BD5,0x9E7D9662,0x933EB0BB,0x97FFAD0C,0xAFB010B1,0xAB710D06,0xA6322BDF,0xA2F33668,0xBCB4666D,0xB8757BDA,0xB5365D03,0xB1F740B4];
function dfNameHash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c >= 97 && c <= 122) c -= 32;
        var bytes;
        if (c < 0x80) { bytes = [c]; }
        else if (c < 0x800) { bytes = [0xC0 | (c >> 6), 0x80 | (c & 0x3F)]; }
        else if (c < 0x10000) { bytes = [0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)]; }
        else { bytes = [0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)]; }
        for (var k = 0; k < bytes.length; k++) {
            h = ((h >>> 8) & 0x00FFFFFF) ^ DF_DEP_TABLE[(h ^ bytes[k]) & 0xFF];
        }
    }
    if (!DF_CRC_TABLE) { dfCrc32(""); }
    var crc = 0xFFFFFFFF;
    for (var j = 0; j < str.length; j++) {
        var ch = str.charCodeAt(j);
        for (var n = 0; n < 4; n++) {
            crc = (crc >>> 8) ^ DF_CRC_TABLE[(crc ^ (ch & 0xFF)) & 0xFF];
            ch >>= 8;
        }
    }
    crc = (~crc) >>> 0;
    return ((h & 0xFFFF) | ((crc & 0xFFFF) << 16)) >>> 0;
}

/* ---------- 长按复制整行 ---------- */
function dfFormatValue(prop) {
    if (!prop) return "";
    var v = prop.value;
    if (prop.type === "BoolProperty") return v ? "True" : "False";
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.length + "]";
    if (typeof v === "object") {
        if (v.assetPathName !== undefined) return v.assetPathName;
        if (v.rotation && v.translation && v.scale3D) {
            return [v.translation.x, v.translation.y, v.translation.z,
                    v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w,
                    v.scale3D.x, v.scale3D.y, v.scale3D.z].join(",");
        }
        if ("x" in v && "y" in v && "z" in v && "w" in v) return v.x + "," + v.y + "," + v.z + "," + v.w;
        if ("x" in v && "y" in v && "z" in v) return v.x + "," + v.y + "," + v.z;
        if ("x" in v && "y" in v) return v.x + "," + v.y;
        if ("r" in v) return v.r + "," + v.g + "," + v.b + "," + v.a;
        return "";
    }
    return String(v);
}

function dfCopyText(text) {
    var ok = false;
    try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
    } catch (e) { ok = false; }
    if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        ok = true;
    }
    showToast(ok ? ("已复制：" + text) : "复制失败");
}

function dfSubItem(prop, row) {
    if (!prop) return "";
    if (row && row.cells && row.cells.length >= 5) {
        var t = row.cells[3].textContent.replace(/\s+/g, " ").trim();
        if (t) return t;
    }
    if (prop.structName) return prop.structName;
    if (prop.enumName) return prop.enumName;
    if (prop.innerType) return prop.innerType;
    if (prop.type === "ObjectProperty" || prop.type === "ClassProperty" ||
        prop.type === "WeakObjectProperty" || prop.type === "SoftObjectProperty" ||
        prop.type === "SoftClassProperty" || prop.type === "LazyObjectProperty" ||
        prop.type === "AssetObjectProperty" || prop.type === "InterfaceProperty") {
        if (prop.rawIndex !== undefined && prop.rawIndex !== null) return String(prop.rawIndex);
    }
    return "";
}

function dfCellValueText(row, prop) {
    if (!prop) return "";
    var v = prop.value;
    if (prop.type === "BoolProperty") return v ? "True" : "False";
    if (prop.type === "StructProperty") {
        var lab = dfStructLabeled(prop);
        if (lab) return lab;
        if (Array.isArray(v)) return "[" + v.length + "]";
        return "";
    }
    if (prop.type === "MapProperty" || prop.type === "SetProperty") {
        if (v && v._isRawMapData && v.rawData) return "[" + Object.keys(v.rawData).length + "]";
        if (Array.isArray(v)) return "[" + v.length + "]";
        return "";
    }
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.length + "]";
    var dom = "";
    try {
        var td = row.cells[row.cells.length - 1];
        var inp = td.querySelector("input[type=checkbox]");
        if (inp) return inp.checked ? "True" : "False";
        inp = td.querySelector("input");
        if (inp) return inp.value;
        var sel = td.querySelector("select");
        if (sel) return sel.value;
        dom = td.textContent.replace(/\s+/g, " ").trim();
    } catch (e) {}
    if (dom && !/点开|➦/.test(dom) && !/^#[0-9a-fA-F]{6,8}$/.test(dom)) {
        return dom.replace(/^Array\s*/, "");
    }
    return dfFormatValue(prop);
}

var dfLastCopyRow = null, dfLastCopyAt = 0;
function dfCopyRow(row) {
    var p = row && row.__dfProp;
    if (!p) return;
    var now = Date.now();
    if (row === dfLastCopyRow && now - dfLastCopyAt < 900) return;
    dfLastCopyRow = row; dfLastCopyAt = now;
    var sub = dfSubItem(p, row);
    var val = dfCellValueText(row, p);
    var parts = [p.name, p.type];
    if (sub) parts.push(sub);
    parts.push(val);
    var line = parts.join(" ");
    dfCopyText(line);
    row.classList.add("df-copied");
    setTimeout(function () { row.classList.remove("df-copied"); }, 400);
}

/* ---------- 结构体带标签格式化： (R=0, G=0, B=0, A=1) ---------- */
function dfNum(x) {
    if (typeof x !== "number") return String(x);
    var r = Math.round(x * 10000) / 10000;
    return String(r);
}

function dfStructLabeled(prop) {
    var v = prop && prop.value;
    if (!v || typeof v !== "object") return "";
    var sn = prop.structName || "";
    function pack(labels, keys) {
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            if (v[keys[i]] === undefined || v[keys[i]] === null) return null;
            out.push(labels[i] + "=" + dfNum(v[keys[i]]));
        }
        return "(" + out.join(", ") + ")";
    }
    if (v.rotation && v.translation && v.scale3D) {
        return "(T=" + [v.translation.x, v.translation.y, v.translation.z].map(dfNum).join(",") +
               ", R=" + [v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w].map(dfNum).join(",") +
               ", S=" + [v.scale3D.x, v.scale3D.y, v.scale3D.z].map(dfNum).join(",") + ")";
    }
    var r;
    if (sn === "Rotator") { r = pack(["Pitch", "Yaw", "Roll"], ["x", "y", "z"]); if (r) return r; }
    if (sn === "LinearColor" || sn === "Color") { r = pack(["R", "G", "B", "A"], ["r", "g", "b", "a"]); if (r) return r; }
    if (sn === "Vector4" || sn === "Quat" || sn === "Plane") { r = pack(["X", "Y", "Z", "W"], ["x", "y", "z", "w"]); if (r) return r; }
    r = pack(["X", "Y", "Z", "W"], ["x", "y", "z", "w"]); if (r) return r;
    r = pack(["X", "Y", "Z"], ["x", "y", "z"]); if (r) return r;
    r = pack(["X", "Y"], ["x", "y"]); if (r) return r;
    r = pack(["R", "G", "B", "A"], ["r", "g", "b", "a"]); if (r) return r;
    return "";
}

