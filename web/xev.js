// Hex Editor - Mobile Interface with Virtual Scrolling
class HexEditor {
    constructor() {
        this.fileBuffer = null;
        this.dataView = null;
        this.fileSize = 0;
        this.selectedStart = -1;
        this.selectedEnd = -1;

        // Virtual scrolling
        this.bytesPerRow = 16;
        this.rowHeight = 18;
        this.visibleRows = 0;
        this.bufferRows = 10;
        this.startRow = 0;
        this.endRow = 0;
        this.totalRows = 0;

        // DOM elements
        this.virtualScroller = document.getElementById('virtualScroller');
        this.virtualContent = document.getElementById('virtualContent');
        this.tabsContainer = document.getElementById('tabsContainer');
        this.hiddenInput = document.getElementById('hiddenInput');
        this.startHandle = document.getElementById('startHandle');
        this.endHandle = document.getElementById('endHandle');

        // Touch interaction state
        this.currentEditColumn = 'hex'; // 'hex' or 'ascii'
        this.isMultiSelectMode = false; // Track if user is in selection mode
        this.longPressTimer = null; // Timer for long-press detection
        this.longPressDelay = 500; // 500ms for long-press

        // Handle dragging state
        this.draggingHandle = null; // 'start' or 'end' or null
        this.handleDragRaf = null;

        // Current file
        this.currentFile = 'file1';
        this.files = new Map();

        // File-specific states (modifiedBytes, history, originalBytes per file)
        this.fileStates = new Map();

        // Current state references (will point to current file's state)
        this.modifiedBytes = new Set();
        this.history = [];
        this.historyIndex = -1;
        this.originalBytes = new Map();

        // Input state (shared, resets on file switch)
        this.inputBuffer = '';
        this.isInputMode = false;
        this.currentEditOffset = -1;
        this.currentEditNibble = 0; // 0 = high nibble, 1 = low nibble

        // History settings
        this.maxHistorySize = 50;

        // Tool state
        this.joinFiles = [];
        this.splitFile = null;
        this.diffFileA = null;
        this.diffFileB = null;
        this.hashFile = null;
        this.stringsFile = null;

        // Scroll animation frame
        this.scrollRaf = null;

        // Selection animation frame
        this.selectionRaf = null;

        // Edge auto-scroll state
        this.autoScrollRaf = null;
        this.isAutoScrolling = false;
        this.autoScrollSpeedX = 0;
        this.autoScrollSpeedY = 0;

        // UAsset Property Diff state
        this.diffMode = 'hex'; // 'hex' or 'property'
        this.uassetFileA = null;
        this.uexpFileA = null;
        this.uassetFileB = null;
        this.uexpFileB = null;
        this.parsedAssetA = null;
        this.parsedAssetB = null;
        this.propertyDiffResults = [];
        this.selectedExportIndex = -1;

        window.app = this;
        this.init();
    }

    showView(viewId) {
        const views = [
            'dashboard', 'fileToolsView', 'stringsView', 'hashView',
            'converterView', 'diffView', 'entropyView',
            'signatureView', 'encodingView', 'hex-grid', 'tabsContainer'
        ];

        views.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        const view = document.getElementById(viewId);
        if (view) {
            view.style.display = (viewId === 'hex-grid') ? 'block' : 'flex';
        }

        // Editor needs tabs shown too
        if (viewId === 'hex-grid') {
            document.getElementById('tabsContainer').style.display = 'flex';
            // Also ensure body class is present if we are in editor with files
            if (this.files.size > 0) {
                document.body.classList.add('file-loaded');
            }
            requestAnimationFrame(() => {
                this.updateViewport();
                this.handleScroll();
                this.render();
            });
        } else {
            // Remove file-loaded class when leaving editor to hide editor-specific buttons
            document.body.classList.remove('file-loaded');
        }

        if (viewId !== 'hex-grid') {
            this.closeDataInspector();
        }
    }

    showStrings() { this.showView('stringsView'); }
    showDiff() { this.showView('diffView'); }
    showEntropy() { this.showView('entropyView'); }
    showXor() { this.showView('xorView'); }
    showSignature() { this.showView('signatureView'); }
    showEncoding() { this.showView('encodingView'); }

    base64Encode() {
        const input = document.getElementById('b64Input').value;
        try {
            document.getElementById('b64Result').value = btoa(input);
        } catch (e) {
            this.showToast('Invalid input for Base64 encoding');
        }
    }

    base64Decode() {
        const input = document.getElementById('b64Input').value;
        try {
            document.getElementById('b64Result').value = atob(input);
        } catch (e) {
            this.showToast('Invalid Base64 string');
        }
    }

    copyB64Result() {
        const result = document.getElementById('b64Result');
        result.select();
        document.execCommand('copy');
        this.showToast('Copied to clipboard!');
    }



    processEntropy() {
        const input = document.getElementById('entropyInput');
        const file = input.files[0];
        if (!file) {
            this.showToast('Please select a file first.');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const buffer = e.target.result;
            const data = new Uint8Array(buffer);
            const canvas = document.getElementById('entropyCanvas');
            const placeholder = document.getElementById('entropyPlaceholder');

            placeholder.style.display = 'none';
            canvas.style.display = 'block';

            this.drawEntropy(data, canvas);
        };
        reader.readAsArrayBuffer(file);
    }

    drawEntropy(data, canvas) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width = canvas.offsetWidth;
        const height = canvas.height = canvas.offsetHeight;

        ctx.clearRect(0, 0, width, height);

        const blockSize = Math.max(1, Math.floor(data.length / width));
        const entropyValues = [];

        for (let i = 0; i < data.length; i += blockSize) {
            const block = data.slice(i, i + blockSize);
            const counts = new Uint32Array(256);
            for (let b of block) counts[b]++;

            let entropy = 0;
            for (let count of counts) {
                if (count > 0) {
                    const p = count / block.length;
                    entropy -= p * Math.log2(p);
                }
            }
            entropyValues.push(entropy / 8); // Normalize to 0-1
        }

        ctx.beginPath();
        ctx.strokeStyle = '#0078a8';
        ctx.lineWidth = 2;

        for (let i = 0; i < entropyValues.length; i++) {
            const x = (i / entropyValues.length) * width;
            const y = height - (entropyValues[i] * height);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    processSignatures() {
        const input = document.getElementById('sigInput');
        const file = input.files[0];
        if (!file) {
            this.showToast('Please select a file first.');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const buffer = e.target.result;
            // Read 512 bytes to catch text signatures
            const data = new Uint8Array(buffer.slice(0, 512));
            const hex = Array.from(data.slice(0, 16)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            const textHeader = new TextDecoder().decode(data);

            // Read last 256 bytes for footer analysis (Unreal PAK)
            const footerBuffer = buffer.slice(-256);
            const footerData = new Uint8Array(footerBuffer);
            const footerHex = Array.from(footerData).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

            const results = document.getElementById('sigResultList');
            results.innerHTML = '';

            const signatures = [
                // Unreal Engine
                { sig: 'C1 83 2A 9E', name: 'Unreal Engine Asset (.uasset)' },
                { sig: '50 41 43 4B', name: 'PAK Archive (Legacy/Quake)' },
                // Images
                { sig: '89 50 4E 47', name: 'PNG Image' },
                { sig: 'FF D8 FF', name: 'JPEG Image' },
                { sig: '47 49 46 38', name: 'GIF Image' },
                { sig: '42 4D', name: 'BMP Image' },
                { sig: '00 00 01 00', name: 'ICO Icon' },
                // Audio / Video
                { sig: '49 44 33', name: 'MP3 Audio (ID3v2)' },
                { sig: 'FF FB', name: 'MP3 Audio (MPEG)' },
                { sig: '4F 67 67 53', name: 'OGG Container' },
                { sig: '66 4C 61 43', name: 'FLAC Audio' },
                { sig: '1A 45 DF A3', name: 'MKV / WebM Video' },
                { sig: '4D 54 68 64', name: 'MIDI Audio' },
                // Archives / Packages
                { sig: '50 4B 03 04', name: 'ZIP / JAR / APK / IPA / Office XML' },
                { sig: '52 61 72 21', name: 'RAR Archive' },
                { sig: '37 7A BC AF', name: '7-Zip Archive' },
                { sig: '1F 8B', name: 'GZIP / TAR.GZ Compressed' },
                { sig: '75 73 74 61', name: 'TAR Archive' },
                { sig: 'FD 37 7A 58 5A', name: 'XZ Compression' },
                // Executables / System
                { sig: '4D 5A', name: 'Windows EXE / DLL' },
                { sig: '7F 45 4C 46', name: 'Linux ELF / Shared Object (.so)' },
                { sig: 'CA FE BA BE', name: 'Java Class / Mach-O' },
                { sig: '53 51 4C 69', name: 'SQLite 3 Database' },
                { sig: '25 50 44 46', name: 'PDF Document' },
                { sig: 'EF BB BF', name: 'UTF-8 Text (BOM)' }
            ];

            let found = false;

            // Check Hex Signatures
            for (let s of signatures) {
                if (hex.startsWith(s.sig)) {
                    results.innerHTML += `<div style="padding: 10px; color: #2da042; font-weight: bold; border-bottom:1px solid #eee;">MATCH: ${s.name}</div>`;
                    found = true;
                }
            }

            // Special Binary Checks
            // Unreal Engine PAK (Footer Magic: 5A 6F 12 E1)
            if (footerHex.includes('5A 6F 12 E1') || footerHex.includes('E1 12 6F 5A')) {
                results.innerHTML += `<div style="padding: 10px; color: #2da042; font-weight: bold; border-bottom:1px solid #eee;">MATCH: Unreal Engine PAK Archive</div>`;
                found = true;
            }
            // RIFF (WAV, WEBP, AVI)
            if (hex.startsWith('52 49 46 46')) {
                const type = textHeader.substring(8, 12);
                results.innerHTML += `<div style="padding: 10px; color: #2da042; font-weight: bold; border-bottom:1px solid #eee;">MATCH: RIFF Container (${type})</div>`;
                found = true;
            }
            // MP4 (ftyp box)
            if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
                const brand = textHeader.substring(8, 12).trim();
                results.innerHTML += `<div style="padding: 10px; color: #2da042; font-weight: bold; border-bottom:1px solid #eee;">MATCH: MP4 / ISO Media (${brand})</div>`;
                found = true;
            }

            // --- 2. Text / Developer File Heuristics ---
            // Detect if file is likely text
            let nullCount = 0;
            for (let i = 0; i < Math.min(data.length, 128); i++) if (data[i] === 0) nullCount++;
            const isBinary = nullCount > 1; // Tolerance for one null byte (e.g. utf16 bom)

            if (!isBinary) {
                const lowerText = textHeader.toLowerCase();
                const trimmed = textHeader.trim();
                const firstLine = textHeader.split('\n')[0].trim();

                // 2.1 Web Technologies
                if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body') || trimmed.startsWith('<script')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: HTML Document</div>`;
                    found = true;
                }
                else if (trimmed.startsWith('<svg') || trimmed.includes('xmlns="http://www.w3.org/2000/svg"')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: SVG Image</div>`;
                    found = true;
                }
                else if (trimmed.startsWith('<?xml')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: XML Data</div>`;
                    found = true;
                }
                // JSON: Starts with { or [ and looks like it
                else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: JSON Data</div>`;
                    found = true;
                }
                // CSS
                else if (
                    lowerText.includes('body {') || lowerText.includes('@media') ||
                    lowerText.includes('div {') || lowerText.includes('!important') ||
                    lowerText.includes(':root') || lowerText.includes('margin:') || lowerText.includes('padding:') ||
                    (lowerText.includes('{') && lowerText.includes('}') && lowerText.includes(':') && lowerText.includes(';'))
                ) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: CSS Style Sheet</div>`;
                    found = true;
                }

                // 2.2 Programming Languages
                // Python
                if (textHeader.startsWith('#!') && lowerText.includes('python')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Python Script (Source)</div>`;
                    found = true;
                }
                else if (lowerText.includes('def ') || lowerText.includes('import ') && lowerText.includes('from ') || lowerText.includes('if __name__')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Python Source</div>`;
                    found = true;
                }
                // JavaScript / TypeScript / React (Basic Heuristics)
                const isJS = (
                    lowerText.includes('function ') || lowerText.includes('const ') || lowerText.includes('let ') || lowerText.includes('var ') ||
                    lowerText.includes('import ') || lowerText.includes('export ') || lowerText.includes('return ')
                ) && (
                        lowerText.includes('console.log') || lowerText.includes('=>') || lowerText.includes('{') || lowerText.includes(';') || lowerText.includes('document.')
                    );

                const hasReact = lowerText.includes('import react') || lowerText.includes('from "react"') || lowerText.includes('from \'react\'') || lowerText.includes('jsx') || lowerText.includes('useeffect') || lowerText.includes('usestate');
                const hasTS = lowerText.includes('interface ') || lowerText.includes('type ') || lowerText.includes(': string') || lowerText.includes(': number') || lowerText.includes(' implements ');
                const hasVue = lowerText.includes('<template>') && lowerText.includes('<script>') && lowerText.includes('<style>');

                if (hasVue) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Vue.js Component</div>`; found = true;
                } else if (hasReact) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: React Component (JSX/TSX)</div>`; found = true;
                } else if (hasTS) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: TypeScript Source</div>`; found = true;
                } else if (isJS) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: JavaScript Source</div>`; found = true;
                }

                // Java
                if (lowerText.includes('public class ') || (lowerText.includes('package ') && lowerText.includes('import java.'))) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Java Source</div>`; found = true;
                }
                // C / C++
                else if (lowerText.includes('#include <') || lowerText.includes('#include "')) {
                    if (lowerText.includes('std::') || lowerText.includes('<iostream>')) {
                        results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: C++ Source</div>`;
                    } else {
                        results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: C / C++ Source</div>`;
                    }
                    found = true;
                }
                // C#
                else if (lowerText.includes('using system;') || lowerText.includes('namespace ')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: C# Source</div>`; found = true;
                }
                // PHP
                else if (trimmed.startsWith('<?php') || lowerText.includes('echo $')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: PHP Script</div>`; found = true;
                }
                // Ruby
                else if ((textHeader.startsWith('#!') && lowerText.includes('ruby')) || lowerText.includes('def ') && lowerText.includes('end') && lowerText.includes('require ')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Ruby Script</div>`; found = true;
                }
                // Go
                else if (lowerText.startsWith('package ') && lowerText.includes('import (') && lowerText.includes('func ')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Go Source</div>`; found = true;
                }
                // Rust
                else if (lowerText.includes('fn main()') || lowerText.includes('let mut ') || lowerText.includes('pub fn ')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Rust Source</div>`; found = true;
                }
                // Kotlin
                else if (lowerText.includes('fun main()') || lowerText.includes('val ') && lowerText.includes('var ') && lowerText.includes('kotlin')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Kotlin Source</div>`; found = true;
                }
                // Swift
                else if (lowerText.includes('import uikit') || lowerText.includes('import swiftui') || lowerText.includes('var body: some view')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Swift Source</div>`; found = true;
                }

                // 2.3 Config / Data / Misc
                // SQL
                if (lowerText.includes('select ') && lowerText.includes('from ') && lowerText.includes('where ') || lowerText.includes('create table ')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: SQL Query / Dump</div>`; found = true;
                }
                // YAML / Frontmatter
                else if (trimmed.startsWith('---') || (lowerText.includes(':') && !lowerText.includes('{') && !lowerText.includes(';'))) {
                    // Very weak check, careful
                    if (lowerText.includes('version:') || lowerText.includes('name:')) {
                        results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: YAML Configuration</div>`; found = true;
                    }
                }
                // TOML
                else if (trimmed.startsWith('[') && trimmed.includes(']') && lowerText.includes('=')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: TOML Configuration</div>`; found = true;
                }
                // INI
                else if (trimmed.startsWith('[') && lowerText.includes('=') && !lowerText.includes('"')) {
                    // Overlap with TOML, but usually simpler
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: INI Configuration</div>`; found = true;
                }
                // ENV
                else if (lowerText.includes('=') && firstLine.includes('=')) {
                    // Check logic: usually KEY=VALUE lines
                    if (!lowerText.includes('{') && !lowerText.includes(';')) {
                        results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: ENV / Config File</div>`; found = true;
                    }
                }
                // CSV
                else if (firstLine.includes(',') && firstLine.split(',').length > 2) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: CSV Data</div>`; found = true;
                }
                // Visual Studio Solution (Specific)
                else if (textHeader.includes('Microsoft Visual Studio Solution File')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Visual Studio Solution (.sln)</div>`; found = true;
                }
                // Markdown
                else if (lowerText.includes('## ') || lowerText.includes('**') || lowerText.includes('```')) {
                    results.innerHTML += `<div style="padding: 10px; color: #0078a8; font-weight: bold;">MATCH: Markdown Document</div>`; found = true;
                }

                // Fallback for generic text
                if (!found && isBinary === false) {
                    results.innerHTML += `<div style="padding: 10px; color: #666; font-weight: bold;">MATCH: Plain Text / Unknown Code</div>`;
                    found = true;
                }
            }

            if (!found) {
                results.innerHTML = `<div style="padding: 10px; font-size: 11px; color: #666;">No magic bytes matched. First bytes: ${hex}</div>`;
            }
        };
        reader.readAsArrayBuffer(file);
    }

    showDashboard() { this.showView('dashboard'); }
    showJoiner() { this.showView('fileToolsView'); this.updateJoinFileList(); }
    showEditor() { this.showView('hex-grid'); }
    showStrings() { this.showView('stringsView'); }
    showHashes() { this.showView('hashView'); }
    showConverter() { this.showView('converterView'); }
    showDiff() { this.showView('diffView'); }
    showEntropy() { this.showView('entropyView'); }

    showSignature() { this.showView('signatureView'); }
    showEncoding() { this.showView('encodingView'); }

    init() {
        // Tab switching is now handled in addTab

        // Tab swipe gesture for file switching
        this.setupTabSwipe();

        // Virtual scroller - native scrolling support
        this.virtualScroller.addEventListener('scroll', () => {
            this.handleScroll();
        }, { passive: true });

        // Mouse handlers for selection
        let mouseStartOffset = -1;
        let isMouseDown = false;

        this.virtualContent.addEventListener('mousedown', (e) => {
            const target = e.target.closest('.hex-byte, .ascii-char');
            if (target && target.dataset.offset) {
                mouseStartOffset = parseInt(target.dataset.offset);
                isMouseDown = true;
                this.selectByte(mouseStartOffset);
                e.preventDefault();
            }
        });

        this.virtualContent.addEventListener('mousemove', (e) => {
            if (isMouseDown && mouseStartOffset >= 0) {
                const target = e.target.closest('.hex-byte, .ascii-char');
                if (target && target.dataset.offset) {
                    const offset = parseInt(target.dataset.offset);
                    this.selectRange(mouseStartOffset, offset);
                    e.preventDefault();
                }
            }
        });

        document.addEventListener('mouseup', () => {
            isMouseDown = false;
            mouseStartOffset = -1;
        });

        // Dashboard Navigation
        document.getElementById('btnGoHex').addEventListener('click', () => {
            if (this.files.size > 0) this.showEditor();
            else this.handleOpenFile();
        });
        document.getElementById('btnGoTools').addEventListener('click', () => this.showJoiner());
        document.getElementById('btnGoStrings').addEventListener('click', () => this.showStrings());
        document.getElementById('btnGoHashes').addEventListener('click', () => this.showHashes());
        document.getElementById('btnGoConverter').addEventListener('click', () => this.showConverter());
        document.getElementById('btnGoDiff').addEventListener('click', () => this.showDiff());
        document.getElementById('btnGoEntropy').addEventListener('click', () => this.showEntropy());

        document.getElementById('btnGoSig').addEventListener('click', () => this.showSignature());
        document.getElementById('btnGoEncode').addEventListener('click', () => this.showEncoding());

        // State variables
        let touchStartOffset = -1;
        let touchStartX = 0;
        let touchStartY = 0;
        let isScrolling = false;

        // Drag State
        this.dragState = {
            active: false,
            handle: null, // 'start' or 'end'
            lockRow: null, // Index of the row we are essentially "locked" to for horizontal drag
            lastX: 0,
            lastY: 0,
            startSelectionStart: -1,
            startSelectionEnd: -1
        };

        // Focus stability
        let shouldKeepFocus = false;
        let keepFocusRaf = null;

        const cancelLongPress = () => {
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
        };

        // Helper: Get offset from screen coordinates
        // This version attempts to find the closest element if exact match fails
        const getOffsetFromCoordinates = (clientX, clientY) => {
            // First try generic elementFromPoint
            let target = document.elementFromPoint(clientX, clientY);
            let closestEl = target?.closest('.hex-byte, .ascii-char');

            if (closestEl && closestEl.dataset.offset) {
                return parseInt(closestEl.dataset.offset);
            }

            // Fallback: Check nearby points (simple cross pattern)
            const offsets = [
                { x: 0, y: -20 }, { x: 0, y: 20 },
                { x: -20, y: 0 }, { x: 20, y: 0 }
            ];

            for (let o of offsets) {
                target = document.elementFromPoint(clientX + o.x, clientY + o.y);
                closestEl = target?.closest('.hex-byte, .ascii-char');
                if (closestEl && closestEl.dataset.offset) {
                    return parseInt(closestEl.dataset.offset);
                }
            }

            return -1;
        };

        const ensureFocus = () => {
            if (shouldKeepFocus && this.hiddenInput && document.activeElement !== this.hiddenInput) {
                this.hiddenInput.focus();
            }
            if (shouldKeepFocus) {
                keepFocusRaf = requestAnimationFrame(ensureFocus);
            } else {
                keepFocusRaf = null;
            }
        };

        const enterSelectionMode = (offset) => {
            this.selectedStart = offset;
            this.selectedEnd = offset;
            if (navigator.vibrate) navigator.vibrate(50);
            if (this.hiddenInput) this.hiddenInput.blur();
            this.render();
            this.updateDataInspector();
            this.showSelectionHandles();
        };

        // --- New Robust Drag Logic ---

        const handleDragStart = (handleType, e) => {
            e.preventDefault();
            e.stopPropagation(); // Stop scrolling

            const touch = e.touches[0];

            // Disable pointer events on handles so elementFromPoint works reliably
            this.startHandle.style.pointerEvents = 'none';
            this.endHandle.style.pointerEvents = 'none';

            this.dragState = {
                active: true,
                handle: handleType,
                startSelectionStart: this.selectedStart,
                startSelectionEnd: this.selectedEnd,
                lastX: touch.clientX,
                lastY: touch.clientY,
                // Lock row logic: Capture the current row of the selection point
                // to prevent jumping up/down easily.
                lockY: touch.clientY
            };

            // Add window listeners for this drag session
            window.addEventListener('touchmove', handleWindowDragMove, { passive: false });
            window.addEventListener('touchend', handleWindowDragEnd, { passive: false });
        };

        const handleWindowDragMove = (e) => {
            if (!this.dragState.active) return;

            // Prevent browser scrolling while dragging handle
            e.preventDefault();

            const touch = e.touches[0];
            const x = touch.clientX;
            let y = touch.clientY;

            // --- Row Locking Mechanism ---
            // Native feel: If moving mostly horizontal, snap Y to valid row center
            // Only change row if delta Y is significant (> 25px)
            const deltaY = Math.abs(y - this.dragState.lockY);
            if (deltaY < 35) {
                // Keep Y locked to initial click height to stay on same line
                y = this.dragState.lockY;
            } else {
                // Unlock if moved significantly
                this.dragState.lockY = y;
            }

            // Offset logic: Finger obscures the point, so look slightly ABOVE finger (approx 40px)
            // But if we are locked, use the lockY (adjustment already implicit in start pos)
            // Visual offset adjustment
            const scanY = y - 20;

            // Get target offset
            let offset = getOffsetFromCoordinates(x, scanY);

            if (offset >= 0) {
                if (this.dragState.handle === 'start') {
                    this.selectedStart = offset;
                } else {
                    this.selectedEnd = offset;
                }

                // Auto-swap start/end if they cross
                // BUT update the handle type in state so we keep dragging the "active" handle
                if (this.selectedStart > this.selectedEnd) {
                    const temp = this.selectedStart;
                    this.selectedStart = this.selectedEnd;
                    this.selectedEnd = temp;

                    // Switch active handle logic
                    this.dragState.handle = (this.dragState.handle === 'start') ? 'end' : 'start';
                }

                this.updateSelectionSmooth(this.selectedStart, this.selectedEnd);
                this.updateDataInspector();
                this.updateHandlePositions();
            }
        };

        const handleWindowDragEnd = (e) => {
            if (this.dragState.active) {
                this.dragState.active = false;
                window.removeEventListener('touchmove', handleWindowDragMove);
                window.removeEventListener('touchend', handleWindowDragEnd);

                // Restore pointer events
                this.startHandle.style.pointerEvents = 'auto';
                this.endHandle.style.pointerEvents = 'auto';

                // Re-focus hidden input for keyboard if needed
                if (this.hiddenInput) {
                    const min = Math.min(this.selectedStart, this.selectedEnd);
                    this.currentEditOffset = min;
                    this.currentEditNibble = 0;
                    shouldKeepFocus = true;
                    this.hiddenInput.value = '';
                    this.hiddenInput.focus();
                    if (!keepFocusRaf) keepFocusRaf = requestAnimationFrame(ensureFocus);
                }
            }
        };

        // Initialize Handles
        this.startHandle.addEventListener('touchstart', (e) => handleDragStart('start', e), { passive: false });
        this.endHandle.addEventListener('touchstart', (e) => handleDragStart('end', e), { passive: false });

        // Touch handler for cells: Long-press to show handles, tap to select
        this.virtualContent.addEventListener('touchstart', (e) => {
            // Ignore if touching a handle
            if (e.target.closest('.selection-handle')) {
                return;
            }

            const target = e.target.closest('.hex-byte, .ascii-char');
            if (target && target.dataset.offset) {
                touchStartOffset = parseInt(target.dataset.offset);
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                isScrolling = false;

                // Cancel any existing long-press timer
                cancelLongPress();

                // Hide handles if we're starting a new interaction
                this.hideSelectionHandles();

                // Stop focus keeping
                shouldKeepFocus = false;
                if (keepFocusRaf) {
                    cancelAnimationFrame(keepFocusRaf);
                    keepFocusRaf = null;
                }

                // Determine which column was tapped
                if (target.classList.contains('hex-byte')) {
                    this.currentEditColumn = 'hex';
                } else if (target.classList.contains('ascii-char')) {
                    this.currentEditColumn = 'ascii';
                }

                // Start long-press timer
                this.longPressTimer = setTimeout(() => {
                    if (touchStartOffset >= 0 && !isScrolling) {
                        enterSelectionMode(touchStartOffset);
                    }
                }, this.longPressDelay);
            }
        }, { passive: true });

        // Touch move: Cancel long-press if scrolling
        this.virtualContent.addEventListener('touchmove', (e) => {
            if (touchStartOffset >= 0 && e.touches.length === 1) {
                const touch = e.touches[0];
                const deltaX = Math.abs(touch.clientX - touchStartX);
                const deltaY = Math.abs(touch.clientY - touchStartY);
                const totalDelta = Math.max(deltaX, deltaY);

                // If user moves finger > 10px, it's a scroll
                if (totalDelta > 10) {
                    isScrolling = true;
                    cancelLongPress();
                }
            }
        }, { passive: true });

        // Touch end: Handle tap or scroll
        this.virtualContent.addEventListener('touchend', (e) => {
            // Ignore if touching a handle
            if (e.target.closest('.selection-handle')) {
                return;
            }

            cancelLongPress();

            // If it was a scroll, do nothing
            if (isScrolling) {
                touchStartOffset = -1;
                isScrolling = false;
                return;
            }

            // If handles are visible, tapping elsewhere should focus input
            if (this.isMultiSelectMode && this.selectedStart >= 0 && this.selectedEnd >= 0) {
                const min = Math.min(this.selectedStart, this.selectedEnd);
                this.currentEditOffset = min;
                this.currentEditNibble = 0;

                shouldKeepFocus = true;
                if (this.hiddenInput) {
                    this.hiddenInput.value = '';
                    this.hiddenInput.focus();
                }

                if (!keepFocusRaf) {
                    keepFocusRaf = requestAnimationFrame(ensureFocus);
                }

                touchStartOffset = -1;
                return;
            }

            // If it was a tap (not scroll, not selection mode)
            if (touchStartOffset >= 0) {
                this.selectedStart = touchStartOffset;
                this.selectedEnd = touchStartOffset;
                this.inputBuffer = '';
                this.isInputMode = false;
                this.currentEditOffset = touchStartOffset;
                this.currentEditNibble = 0;
                this.render();
                this.updateDataInspector();
                this.hideSelectionHandles();

                // Focus input for editing
                if (this.hiddenInput) {
                    shouldKeepFocus = true;
                    this.hiddenInput.value = '';
                    this.hiddenInput.focus();

                    if (!keepFocusRaf) {
                        keepFocusRaf = requestAnimationFrame(ensureFocus);
                    }

                    // Wait for keyboard animation to finish, then scroll selection into view
                    // This prevents keyboard from occluding the selected byte
                    setTimeout(() => {
                        this.scrollSelectionIntoView();
                    }, 300);
                } else {
                    // If no input (desktop), still scroll immediately
                    requestAnimationFrame(() => {
                        this.scrollSelectionIntoView();
                    });
                }
            }

            touchStartOffset = -1;
            isScrolling = false;
        }, { passive: true });

        this.virtualContent.addEventListener('touchcancel', () => {
            cancelLongPress();
            hideSelectionHandles();

            shouldKeepFocus = false;
            if (keepFocusRaf) {
                cancelAnimationFrame(keepFocusRaf);
                keepFocusRaf = null;
            }

            touchStartOffset = -1;
            isScrolling = false;
        }, { passive: true });

        // Keyboard input handler
        document.addEventListener('keydown', (e) => {
            if (this.selectedStart < 0 || !this.fileBuffer) return;

            // Ignore if user is typing in some other input (unlikely here but safe)
            if (e.target.tagName === 'INPUT' && e.target !== this.hiddenInput) return;

            const key = e.key;

            if (this.currentEditColumn === 'hex') {
                // Hex column: Only 0-9A-F
                if (/[0-9A-Fa-f]/.test(key) && key.length === 1) {
                    e.preventDefault();
                    this.handleHexInput(key.toUpperCase());
                } else if (key === 'Backspace' || key === 'Delete') {
                    e.preventDefault();
                    this.handleHexInput('0');
                }
            } else {
                // ASCII column: Accept all single characters
                if (key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    this.handleAsciiInput(key);
                }
            }
        });

        // Hidden input handler for mobile keyboard
        if (this.hiddenInput) {
            this.hiddenInput.addEventListener('input', (e) => {
                if (this.selectedStart < 0 || !this.fileBuffer) {
                    this.hiddenInput.value = '';
                    return;
                }

                const inputValue = this.hiddenInput.value;
                if (inputValue.length === 0) return;

                // Capture raw input: Get the last character exactly as typed (preserve case)
                const rawLastChar = inputValue[inputValue.length - 1];

                // Conditional processing based on column type
                let processedChar = rawLastChar;
                let isValid = false;

                if (this.currentEditColumn === 'hex') {
                    // Hex column: Convert to uppercase and validate against /[0-9A-F]/
                    processedChar = rawLastChar.toUpperCase();
                    isValid = /[0-9A-F]/.test(processedChar);
                } else if (this.currentEditColumn === 'ascii') {
                    // ASCII column: Keep character as-is (do NOT convert to uppercase)
                    processedChar = rawLastChar;
                    // Consider it valid (allow all characters)
                    isValid = true;
                }

                if (isValid) {
                    if (this.currentEditColumn === 'hex') {
                        // Handle hex input with uppercase character
                        this.handleHexInput(processedChar);
                    } else {
                        // Handle ASCII input - Pass case-sensitive character
                        this.handleAsciiInput(processedChar);
                    }

                    // Clear input and refocus for next character
                    this.hiddenInput.value = '';
                    // Ensure focus keeping is active
                    shouldKeepFocus = true;
                    // Small delay to ensure keyboard stays open
                    setTimeout(() => {
                        if (this.selectedStart >= 0 && shouldKeepFocus) {
                            this.hiddenInput.focus();
                        }
                    }, 10);
                } else {
                    // Invalid character - remove it
                    this.hiddenInput.value = inputValue.slice(0, -1);
                }
            });

            // Handle focus - Auto-scroll to keep selection visible when keyboard opens
            this.hiddenInput.addEventListener('focus', () => {
                if (this.selectedStart >= 0 && this.currentEditOffset >= 0) {
                    // Wait for keyboard animation to finish before calculating scroll
                    setTimeout(() => {
                        this.scrollSelectionIntoView();
                    }, 300);
                }
            });

            // Handle blur - Keep Focus mechanism: re-focus if unexpected blur happens during selection
            this.hiddenInput.addEventListener('blur', () => {
                // If we should keep focus (in selection mode or during editing), re-focus
                if (shouldKeepFocus && this.selectedStart >= 0) {
                    // Use setTimeout to avoid immediate re-focus conflicts
                    setTimeout(() => {
                        if (shouldKeepFocus && this.hiddenInput && this.selectedStart >= 0) {
                            this.hiddenInput.focus();
                        }
                    }, 50);
                }
            });
        }

        // Helper to prevent keyboard flicker on UI button clicks
        const preventKeyboardFlicker = (handler) => {
            return (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Temporarily disable focus keeping
                const wasKeepingFocus = shouldKeepFocus;
                shouldKeepFocus = false;

                // Blur input to dismiss keyboard
                if (this.hiddenInput) {
                    this.hiddenInput.blur();
                }

                // Cancel any focus keeping RAF
                if (keepFocusRaf) {
                    cancelAnimationFrame(keepFocusRaf);
                    keepFocusRaf = null;
                }

                // Execute the handler
                handler.call(this, e);

                // Optionally re-enable focus after a delay if selection is still active
                setTimeout(() => {
                    if (this.selectedStart >= 0 && this.selectedEnd >= 0 && wasKeepingFocus) {
                        // Only re-enable if user had focus before and selection still exists
                        // But don't auto-focus, let user decide
                        shouldKeepFocus = false;
                    }
                }, 100);
            };
        };

        const backBtn = document.getElementById('backBtn');
        if (backBtn) {
            backBtn.addEventListener('click', preventKeyboardFlicker(() => {
                if (document.getElementById('dashboard').style.display === 'none') {
                    this.showDashboard();
                } else {
                    window.location.href = 'viewer.html';
                }
            }));
        }

        // File Inputs
        const openBtn = document.getElementById('openBtn');
        if (openBtn) openBtn.addEventListener('click', preventKeyboardFlicker(() => this.handleOpenFile()));

        const joinInput = document.getElementById('joinInput');
        if (joinInput) {
            joinInput.addEventListener('change', (e) => {
                const files = e.target.files;
                for (let i = 0; i < files.length; i++) this.joinFiles.push(files[i]);
                this.updateJoinFileList();
                // Show naming container if files selected
                if (this.joinFiles.length > 0) {
                    document.getElementById('joinOutputContainer').style.display = 'block';
                }
            });
        }

        const splitInput = document.getElementById('splitInput');
        if (splitInput) {
            splitInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.splitFile = file;
                    document.getElementById('splitFileNameDisplay').textContent = file.name;
                    // Show settings container
                    document.getElementById('splitSettingsContainer').style.display = 'block';
                }
            });
        }

        const stringInput = document.getElementById('stringInput');
        if (stringInput) {
            stringInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.stringsFile = file;
                    document.getElementById('stringFileNameDisplay').textContent = file.name;
                }
            });
        }

        const hashInput = document.getElementById('hashInput');
        if (hashInput) {
            hashInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.hashFile = file;
                    document.getElementById('hashFileNameDisplay').textContent = file.name;
                }
            });
        }

        const diffInputA = document.getElementById('diffInputA');
        if (diffInputA) {
            diffInputA.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.diffFileA = file;
                    document.getElementById('diffFileNameA').textContent = file.name;
                }
            });
        }

        const diffInputB = document.getElementById('diffInputB');
        if (diffInputB) {
            diffInputB.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.diffFileB = file;
                    document.getElementById('diffFileNameB').textContent = file.name;
                }
            });
        }

        const entropyInput = document.getElementById('entropyInput');
        if (entropyInput) {
            entropyInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    document.getElementById('entropyFileNameDisplay').textContent = file.name;
                }
            });
        }

        const sigInput = document.getElementById('sigInput');
        if (sigInput) {
            sigInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    document.getElementById('sigFileNameDisplay').textContent = file.name;
                }
            });
        }

        // UAsset Property Diff file inputs
        const getBaseName = (name) => name.split('.').slice(0, -1).join('.').toLowerCase();

        const uassetInputA = document.getElementById('uassetInputA');
        if (uassetInputA) {
            uassetInputA.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    if (this.uexpFileA) {
                        if (getBaseName(file.name) !== getBaseName(this.uexpFileA.name)) {
                            this.showToast(`Error: Filename must match ${this.uexpFileA.name}`);
                            e.target.value = ''; // Reset input
                            return;
                        }
                    }
                    this.uassetFileA = file;
                    const el = document.getElementById('uassetFileNameA');
                    el.textContent = file.name;
                    el.style.color = '#22c55e';
                    el.style.fontStyle = 'normal';
                    this.tryParseAssets();
                }
            });
        }

        const uexpInputA = document.getElementById('uexpInputA');
        if (uexpInputA) {
            uexpInputA.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    if (this.uassetFileA) {
                        if (getBaseName(file.name) !== getBaseName(this.uassetFileA.name)) {
                            this.showToast(`Error: Filename must match ${this.uassetFileA.name}`);
                            e.target.value = ''; // Reset input
                            return;
                        }
                    }
                    this.uexpFileA = file;
                    const el = document.getElementById('uexpFileNameA');
                    el.textContent = file.name;
                    el.style.color = '#22c55e';
                    el.style.fontStyle = 'normal';
                    this.tryParseAssets();
                }
            });
        }

        const uassetInputB = document.getElementById('uassetInputB');
        if (uassetInputB) {
            uassetInputB.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    if (this.uexpFileB) {
                        if (getBaseName(file.name) !== getBaseName(this.uexpFileB.name)) {
                            this.showToast(`Error: Filename must match ${this.uexpFileB.name}`);
                            e.target.value = ''; // Reset input
                            return;
                        }
                    }
                    this.uassetFileB = file;
                    const el = document.getElementById('uassetFileNameB');
                    el.textContent = file.name;
                    el.style.color = '#22c55e';
                    el.style.fontStyle = 'normal';
                    this.tryParseAssets();
                }
            });
        }

        const uexpInputB = document.getElementById('uexpInputB');
        if (uexpInputB) {
            uexpInputB.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    if (this.uassetFileB) {
                        if (getBaseName(file.name) !== getBaseName(this.uassetFileB.name)) {
                            this.showToast(`Error: Filename must match ${this.uassetFileB.name}`);
                            e.target.value = ''; // Reset input
                            return;
                        }
                    }
                    this.uexpFileB = file;
                    const el = document.getElementById('uexpFileNameB');
                    el.textContent = file.name;
                    el.style.color = '#22c55e';
                    el.style.fontStyle = 'normal';
                    this.tryParseAssets();
                }
            });
        }

        const saveBtn = document.getElementById('saveBtn');
        if (saveBtn) saveBtn.addEventListener('click', preventKeyboardFlicker(() => this.handleSaveFile()));

        const undoBtn = document.getElementById('undoBtn');
        if (undoBtn) undoBtn.addEventListener('click', preventKeyboardFlicker(() => this.handleUndo()));

        const redoBtn = document.getElementById('redoBtn');
        if (redoBtn) redoBtn.addEventListener('click', preventKeyboardFlicker(() => this.handleRedo()));

        const menuToggle = document.getElementById('menuToggle');
        if (menuToggle) menuToggle.addEventListener('click', preventKeyboardFlicker(() => this.toggleDataInspector()));

        const sidebarOverlay = document.getElementById('sidebarOverlay');
        if (sidebarOverlay) sidebarOverlay.addEventListener('click', preventKeyboardFlicker(() => this.closeDataInspector()));

        // Navigation buttons inside inspector
        const navFirst = document.getElementById('navFirst');
        const navPrev = document.getElementById('navPrev');
        const navNext = document.getElementById('navNext');
        const navLast = document.getElementById('navLast');

        if (navFirst) navFirst.addEventListener('click', preventKeyboardFlicker(() => this.navigateSelection('first')));
        if (navPrev) navPrev.addEventListener('click', preventKeyboardFlicker(() => this.navigateSelection('prev')));
        if (navNext) navNext.addEventListener('click', preventKeyboardFlicker(() => this.navigateSelection('next')));
        if (navLast) navLast.addEventListener('click', preventKeyboardFlicker(() => this.navigateSelection('last')));

        // No byte order or hex base options anymore

        // Window resize
        window.addEventListener('resize', () => {
            this.updateViewport();
        });

        // Initial render
        this.updateViewport();
        this.render();
        this.updateHistoryButtons();

        // Update data inspector when selection changes
        this.updateDataInspector();
        this.updateDataInspectorVisibility();

        // Force update visibility after file load
        setTimeout(() => {
            this.updateDataInspectorVisibility();
        }, 100);

        // Modal Button Listeners
        const modalYes = document.getElementById('modalYes');
        const modalNo = document.getElementById('modalNo');
        if (modalYes) modalYes.addEventListener('click', () => this.handleModalResult(true));
        if (modalNo) modalNo.addEventListener('click', () => this.handleModalResult(false));
    }

    showToast(message, duration = 2500) {
        const toast = document.getElementById('customToast');
        if (!toast) return;

        toast.textContent = message;
        toast.classList.add('show');

        if (this.toastTimeout) clearTimeout(this.toastTimeout);
        this.toastTimeout = setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }

    showConfirm(message, callback) {
        const overlay = document.getElementById('modalOverlay');
        const msgEl = document.getElementById('modalMessage');
        const inputContainer = document.getElementById('modalInputContainer');
        if (!overlay || !msgEl) return;

        if (inputContainer) inputContainer.style.display = 'none';

        msgEl.textContent = message;
        overlay.style.display = 'flex';
        this.modalCallback = callback;
    }

    showPrompt(message, defaultValue, callback) {
        const overlay = document.getElementById('modalOverlay');
        const msgEl = document.getElementById('modalMessage');
        const inputContainer = document.getElementById('modalInputContainer');
        const input = document.getElementById('modalInput');

        if (!overlay || !msgEl || !inputContainer || !input) return;

        msgEl.textContent = message;
        input.value = defaultValue || '';
        inputContainer.style.display = 'block';
        overlay.style.display = 'flex';

        input.focus();
        input.select();

        this.modalCallback = (result) => {
            if (result) {
                callback(input.value);
            } else {
                callback(null);
            }
        };

        // Handle Enter key
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.handleModalResult(true);
            }
        };
    }

    handleModalResult(result) {
        const overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.style.display = 'none';
        if (this.modalCallback) {
            this.modalCallback(result);
            this.modalCallback = null;
        }
    }

    handleOpenFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';

        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // Save current file's state before opening new file
            if (this.currentFile && this.fileBuffer) {
                this.saveFileState(this.currentFile);
            }

            const reader = new FileReader();
            reader.onload = (event) => {
                const buffer = event.target.result;
                const fileId = `file_${Date.now()}`;
                const fileName = file.name; // Show full filename

                this.files.set(fileId, buffer);
                this.addTab(fileId, fileName);
                this.switchTab(fileId);
                this.showEditor(); // Jump to editor
            };

            reader.readAsArrayBuffer(file);
        });

        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
    }

    addTab(fileId, fileName) {
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.file = fileId;

        // Tab name
        const tabName = document.createElement('span');
        tabName.className = 'tab-name';
        tabName.textContent = fileName;
        tab.appendChild(tabName);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.innerHTML = '×';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent tab switch
            this.closeFile(fileId);
        });
        tab.appendChild(closeBtn);

        // Tab click to switch
        tab.addEventListener('click', (e) => {
            // Don't switch if clicking the close button
            if (e.target === closeBtn || e.target.closest('.tab-close')) {
                return;
            }
            this.switchTab(fileId);
        });

        // Remove active class from all tabs
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        this.tabsContainer.appendChild(tab);

        // Scroll to make new tab visible
        setTimeout(() => {
            tab.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'start'
            });
        }, 0);
    }

    closeFile(fileId) {
        // Save state before closing
        if (this.currentFile === fileId && this.fileBuffer) {
            this.saveFileState(fileId);
        }

        // Remove file
        this.files.delete(fileId);
        this.fileStates.delete(fileId);

        // Remove tab
        const tab = document.querySelector(`[data-file="${fileId}"]`);
        if (tab) {
            tab.remove();
        }

        // If closing current file, switch to another file or show empty state
        if (this.currentFile === fileId) {
            const remainingTabs = document.querySelectorAll('.tab');
            if (remainingTabs.length > 0) {
                // Switch to another file
                const firstTab = remainingTabs[0];
                this.switchTab(firstTab.dataset.file);
            } else {
                // No files left - show empty state
                this.fileBuffer = null;
                this.dataView = null;
                this.fileSize = 0;
                this.selectedStart = -1;
                this.selectedEnd = -1;
                this.modifiedBytes.clear();
                this.history = [];
                this.historyIndex = -1;
                this.originalBytes.clear();
                this.currentFile = null;

                // Remove file-loaded class when no files are open
                document.body.classList.remove('file-loaded');

                // Show empty state
                const emptyState = document.getElementById('emptyState');
                if (emptyState) {
                    emptyState.classList.remove('hidden');
                }

                this.virtualContent.innerHTML = '';
                this.virtualContent.style.height = '0px';
                this.updateSaveButton();
                this.updateHistoryButtons();
            }
        }
    }

    saveFileState(fileId) {
        // Save current state for the file (use updateCurrentFileState logic)
        this.updateCurrentFileState();
    }

    loadFileState(fileId, originalBuffer) {
        let state = this.fileStates.get(fileId);

        if (!state) {
            // Create new state for this file
            state = {
                modifiedBytes: new Set(),
                history: [],
                historyIndex: -1,
                originalBytes: new Map(),
                fileBuffer: originalBuffer.slice(0) // Copy of original buffer
            };

            // Store original byte values
            const tempDataView = new DataView(originalBuffer);
            for (let i = 0; i < originalBuffer.byteLength; i++) {
                state.originalBytes.set(i, tempDataView.getUint8(i));
            }

            this.fileStates.set(fileId, state);

            // Use original buffer for new file
            this.fileBuffer = originalBuffer.slice(0);
            this.dataView = new DataView(this.fileBuffer);
            this.fileSize = this.fileBuffer.byteLength;
        } else {
            // Restore buffer from saved state (contains modifications)
            if (state.fileBuffer) {
                this.fileBuffer = state.fileBuffer;
                this.dataView = new DataView(this.fileBuffer);
                this.fileSize = this.fileBuffer.byteLength;
            } else {
                // Fallback to original buffer
                this.fileBuffer = originalBuffer.slice(0);
                this.dataView = new DataView(this.fileBuffer);
                this.fileSize = this.fileBuffer.byteLength;
            }
        }

        // Load state into current references (create new instances to avoid reference issues)
        this.modifiedBytes = new Set(state.modifiedBytes);
        this.history = JSON.parse(JSON.stringify(state.history));
        this.historyIndex = state.historyIndex;
        this.originalBytes = new Map(state.originalBytes);
    }

    loadFile(fileId) {
        const originalBuffer = this.files.get(fileId);
        if (!originalBuffer) return;

        // Add class to body to show UI elements (Save, Undo, Redo, Menu)
        document.body.classList.add('file-loaded');

        // Save current file's state before switching (save old file's state)
        const oldFileId = this.currentFile;
        if (oldFileId && oldFileId !== fileId && this.fileBuffer) {
            this.saveFileState(oldFileId);
        }

        // Switch to new file
        this.currentFile = fileId;
        this.selectedStart = -1;
        this.selectedEnd = -1;

        // Load or create file state (this will set fileBuffer, dataView, fileSize)
        this.loadFileState(fileId, originalBuffer);

        // Reset input state
        this.inputBuffer = '';
        this.isInputMode = false;
        this.currentEditOffset = -1;
        this.currentEditNibble = 0;

        this.updateHistoryButtons();
        this.updateSaveButton();

        // Hide empty state
        const emptyState = document.getElementById('emptyState');
        if (emptyState) {
            emptyState.classList.add('hidden');
        }

        // Initialize history buttons
        this.updateHistoryButtons();

        // Calculate total rows
        this.totalRows = Math.ceil(this.fileSize / this.bytesPerRow);

        // Set virtual content height
        this.virtualContent.style.height = `${this.totalRows * this.rowHeight}px`;

        this.updateViewport();
        this.render();

        // Auto-select first byte when file is loaded
        if (this.fileSize > 0) {
            this.selectByte(0);
        }

        // Update data inspector visibility after file load
        this.updateDataInspectorVisibility();

        // Auto-open Data Inspector on file load
        this.toggleDataInspector();
    }

    switchTab(fileId) {
        // Update tab UI
        const tab = document.querySelector(`[data-file="${fileId}"]`);
        if (!tab) return;

        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Scroll to make active tab fully visible
        // Use 'start' to ensure the tab is fully visible from the left
        tab.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'start'
        });

        this.currentFile = fileId;
        this.loadFile(fileId);
    }

    setupTabSwipe() {
        let touchStartX = 0;
        let touchStartY = 0;
        let touchEndX = 0;
        let touchEndY = 0;
        const minSwipeDistance = 50; // Minimum distance for swipe

        this.tabsContainer.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: true });

        this.tabsContainer.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            touchEndY = e.changedTouches[0].screenY;

            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;

            // Check if horizontal swipe is dominant
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > minSwipeDistance) {
                const tabs = Array.from(document.querySelectorAll('.tab'));
                const currentTab = tabs.find(t => t.classList.contains('active'));

                if (!currentTab) return;

                const currentIndex = tabs.indexOf(currentTab);

                if (deltaX > 0) {
                    // Swipe right - go to previous file
                    if (currentIndex > 0) {
                        const prevTab = tabs[currentIndex - 1];
                        this.switchTab(prevTab.dataset.file);
                    }
                } else {
                    // Swipe left - go to next file
                    if (currentIndex < tabs.length - 1) {
                        const nextTab = tabs[currentIndex + 1];
                        this.switchTab(nextTab.dataset.file);
                    }
                }
            }
        }, { passive: true });
    }

    updateViewport() {
        const scrollerHeight = this.virtualScroller.clientHeight;
        this.visibleRows = Math.ceil(scrollerHeight / this.rowHeight);
        this.handleScroll();
    }

    handleScroll() {
        if (!this.fileBuffer || this.totalRows === 0) return;

        const scrollTop = this.virtualScroller.scrollTop;
        const scrollLeft = this.virtualScroller.scrollLeft;
        const startRow = Math.floor(scrollTop / this.rowHeight);

        // Add buffer rows
        this.startRow = Math.max(0, startRow - this.bufferRows);
        this.endRow = Math.min(this.totalRows, startRow + this.visibleRows + this.bufferRows);

        // Only render if row range changed to improve performance
        const currentStartRow = this.startRow;
        const currentEndRow = this.endRow;

        // Use requestAnimationFrame for smooth updates during scroll
        if (!this.scrollRaf) {
            this.scrollRaf = requestAnimationFrame(() => {
                this.render();
                // Update handle positions after render
                if (this.isMultiSelectMode) {
                    this.updateHandlePositions();
                }
                this.scrollRaf = null;
            });
        }
    }

    updateHandlePositions() {
        if (this.selectedStart < 0 || this.selectedEnd < 0 || !this.fileBuffer) {
            this.hideSelectionHandles();
            return;
        }

        const selectorPrefix = this.currentEditColumn === 'ascii' ? '.ascii-char' : '.hex-byte';
        const startElement = this.virtualContent.querySelector(`${selectorPrefix}[data-offset="${this.selectedStart}"]`);
        const endElement = this.virtualContent.querySelector(`${selectorPrefix}[data-offset="${this.selectedEnd}"]`);

        if (!startElement || !endElement) {
            this.hideSelectionHandles();
            return;
        }

        const startRect = startElement.getBoundingClientRect();
        const endRect = endElement.getBoundingClientRect();
        const mainRect = document.getElementById('hex-grid').getBoundingClientRect();

        let startHandleX = startRect.left - mainRect.left;
        let startHandleY = startRect.bottom - mainRect.top;
        let endHandleX = endRect.right - mainRect.left;
        let endHandleY = endRect.bottom - mainRect.top;

        // Anti-overlap logic for ASCII
        if (this.currentEditColumn === 'ascii') {
            const distance = endHandleX - startHandleX;
            if (distance < 16) {
                // If they are too close, offset them so they don't block the character
                startHandleX -= 4;
                endHandleX += 4;
            }
        }

        this.startHandle.style.transform = `translate(${startHandleX - 12}px, ${startHandleY - 4}px) rotate(-45deg)`;
        this.endHandle.style.transform = `translate(${endHandleX - 4}px, ${endHandleY - 4}px) rotate(45deg)`;

        const scrollerTop = this.virtualScroller.scrollTop;
        const scrollerBottom = scrollerTop + this.virtualScroller.clientHeight;
        const startRow = Math.floor(this.selectedStart / this.bytesPerRow);
        const endRow = Math.floor(this.selectedEnd / this.bytesPerRow);
        const startRowTop = startRow * this.rowHeight;
        const startRowBottom = (startRow + 1) * this.rowHeight;
        const endRowTop = endRow * this.rowHeight;
        const endRowBottom = (endRow + 1) * this.rowHeight;

        const isStartVisible = startRowBottom > scrollerTop && startRowTop < scrollerBottom;
        const isEndVisible = endRowBottom > scrollerTop && endRowTop < scrollerBottom;

        if (isStartVisible || isEndVisible) {
            // Position Start Handle (Bottom-Left of start element)
            if (startElement) {
                this.startHandle.style.left = `${startElement.offsetLeft}px`;
                // Position at bottom of line implies using rowBottom or element top + height
                this.startHandle.style.top = `${startElement.offsetTop + startElement.offsetHeight}px`;
            }

            // Position End Handle (Bottom-Right of end element)
            if (endElement) {
                this.endHandle.style.left = `${endElement.offsetLeft + endElement.offsetWidth}px`;
                this.endHandle.style.top = `${endElement.offsetTop + endElement.offsetHeight}px`;
            }

            this.startHandle.classList.add('visible');
            this.endHandle.classList.add('visible');
        } else {
            this.hideSelectionHandles();
        }
    }

    updateSelectionVisuals() {
        if (!this.fileBuffer) return;
        const min = Math.min(this.selectedStart, this.selectedEnd);
        const max = Math.max(this.selectedStart, this.selectedEnd);

        const elements = this.virtualContent.querySelectorAll('.hex-byte, .ascii-char');
        elements.forEach(el => {
            const offset = parseInt(el.dataset.offset);
            if (offset >= min && offset <= max) {
                el.classList.add('selected');
            } else {
                el.classList.remove('selected');
            }
        });
    }

    showSelectionHandles() {
        if (this.selectedStart < 0 || this.selectedEnd < 0) {
            this.hideSelectionHandles();
            return;
        }

        this.updateHandlePositions();
        this.isMultiSelectMode = true;
    }

    hideSelectionHandles() {
        if (this.startHandle) this.startHandle.classList.remove('visible');
        if (this.endHandle) this.endHandle.classList.remove('visible');
        this.isMultiSelectMode = false;
    }

    render() {
        if (!this.fileBuffer || this.totalRows === 0) {
            this.virtualContent.innerHTML = '';
            // Show empty state if no file is loaded
            const emptyState = document.getElementById('emptyState');
            if (emptyState && this.files.size === 0) {
                emptyState.classList.remove('hidden');
            }
            return;
        }

        // Clear previous content
        this.virtualContent.innerHTML = '';

        // Render visible rows
        for (let row = this.startRow; row < this.endRow; row++) {
            const rowOffset = row * this.bytesPerRow;
            const top = row * this.rowHeight;

            const rowDiv = document.createElement('div');
            rowDiv.className = 'hex-row';
            rowDiv.dataset.row = row;
            rowDiv.style.position = 'absolute';
            rowDiv.style.top = `${top}px`;
            rowDiv.style.left = '0';
            rowDiv.style.width = '100%';
            rowDiv.style.minWidth = 'max-content';

            // Offset column
            const offsetDiv = document.createElement('div');
            offsetDiv.className = 'offset-column';
            offsetDiv.textContent = this.formatOffset(rowOffset);
            rowDiv.appendChild(offsetDiv);

            // Hex column
            const hexDiv = document.createElement('div');
            hexDiv.className = 'hex-column';

            // ASCII column
            const asciiDiv = document.createElement('div');
            asciiDiv.className = 'ascii-column';

            for (let i = 0; i < this.bytesPerRow; i++) {
                const offset = rowOffset + i;

                if (offset >= this.fileSize) {
                    // Empty space for incomplete rows
                    const emptyHex = document.createElement('span');
                    emptyHex.style.width = '20px';
                    emptyHex.style.display = 'inline-block';
                    hexDiv.appendChild(emptyHex);

                    const emptyAscii = document.createElement('span');
                    emptyAscii.style.width = '10px';
                    emptyAscii.style.display = 'inline-block';
                    asciiDiv.appendChild(emptyAscii);
                    continue;
                }

                const byte = this.dataView.getUint8(offset);

                // Hex byte
                const hexByte = document.createElement('span');
                hexByte.className = 'hex-byte';
                hexByte.textContent = this.formatByte(byte);
                hexByte.dataset.offset = offset;

                // Check if selected
                if (this.isSelected(offset)) {
                    hexByte.classList.add('selected');
                }

                // Check if modified
                if (this.modifiedBytes.has(offset)) {
                    hexByte.classList.add('modified');
                }

                hexDiv.appendChild(hexByte);

                // ASCII char
                const asciiChar = document.createElement('span');
                asciiChar.className = 'ascii-char';
                asciiChar.textContent = this.getAsciiChar(byte);
                asciiChar.dataset.offset = offset;
                asciiChar.style.cursor = 'pointer';
                asciiChar.style.touchAction = 'manipulation';

                if (this.isSelected(offset)) {
                    asciiChar.classList.add('selected');
                }

                // Check if modified
                if (this.modifiedBytes.has(offset)) {
                    asciiChar.classList.add('modified');
                }

                asciiDiv.appendChild(asciiChar);
            }

            rowDiv.appendChild(hexDiv);
            rowDiv.appendChild(asciiDiv);
            this.virtualContent.appendChild(rowDiv);
        }
    }

    isSelected(offset) {
        if (this.selectedStart < 0 || this.selectedEnd < 0) return false;
        const min = Math.min(this.selectedStart, this.selectedEnd);
        const max = Math.max(this.selectedStart, this.selectedEnd);
        return offset >= min && offset <= max;
    }

    isHighlighted(offset) {
        // Highlight certain patterns like JPEG markers
        // Check for "46 49 46" (FIF) pattern
        if (offset + 2 < this.fileSize) {
            const b1 = this.dataView.getUint8(offset);
            const b2 = this.dataView.getUint8(offset + 1);
            const b3 = this.dataView.getUint8(offset + 2);

            // FIF pattern
            if (b1 === 0x46 && b2 === 0x49 && b3 === 0x46) {
                return true;
            }

            // 01 00 01 pattern
            if (b1 === 0x01 && b2 === 0x00 && b3 === 0x01) {
                return true;
            }

            // 28 49 43 pattern (ICC)
            if (b1 === 0x28 && b2 === 0x49 && b3 === 0x43) {
                return true;
            }
        }

        // Check if part of a highlighted range
        if (offset >= 0x1B8 && offset <= 0x1BA) return true; // FIF
        if (offset >= 0x1C0 && offset <= 0x1C2) return true; // 01 00 01
        if (offset >= 0x1C8 && offset <= 0x1CA) return true; // 28 49 43

        return false;
    }

    selectByte(offset) {
        if (offset < 0 || offset >= this.fileSize) return;

        this.selectedStart = offset;
        this.selectedEnd = offset;
        this.inputBuffer = '';
        this.isInputMode = false;
        this.currentEditOffset = offset; // Set for scrollSelectionIntoView
        this.currentEditNibble = 0;

        // Hide handles for programmatic selection (mouse, navigation)
        this.hideSelectionHandles();

        this.render();

        // Scroll to selected byte if not visible (basic scroll)
        this.scrollToOffset(offset);

        // Force scroll to top 30-40% for keyboard occlusion prevention
        // Wait a frame to ensure DOM is updated, then scroll
        requestAnimationFrame(() => {
            this.scrollSelectionIntoView();
        });

        this.updateDataInspector();
    }

    selectRange(start, end) {
        if (start < 0 || end < 0 || start >= this.fileSize || end >= this.fileSize) return;

        this.selectedStart = start;
        this.selectedEnd = end;
        this.inputBuffer = '';
        this.isInputMode = false;
        this.currentEditOffset = -1;
        this.currentEditNibble = 0;

        // Hide handles for programmatic selection (mouse, navigation)
        this.hideSelectionHandles();

        this.render();
        this.updateDataInspector();
    }

    updateSelectionSmooth(start, end) {
        // Cancel any pending selection update
        if (this.selectionRaf) {
            cancelAnimationFrame(this.selectionRaf);
        }

        // Update selection immediately
        this.selectRange(start, end);

        // Use requestAnimationFrame for smooth updates during drag
        this.selectionRaf = requestAnimationFrame(() => {
            this.selectionRaf = null;
        });
    }

    handleEdgeAutoScroll(touch) {
        // Edge auto-scrolling (both vertical and horizontal)
        const EDGE_SCROLL_THRESHOLD = 50; // pixels from edge to trigger auto-scroll
        const AUTO_SCROLL_SPEED = 8; // pixels per frame

        const scrollerRect = this.virtualScroller.getBoundingClientRect();
        const scrollerTop = scrollerRect.top;
        const scrollerLeft = scrollerRect.left;
        const scrollerHeight = scrollerRect.height;
        const scrollerWidth = scrollerRect.width;
        const relativeY = touch.clientY - scrollerTop;
        const relativeX = touch.clientX - scrollerLeft;

        let scrollY = 0;
        let scrollX = 0;

        // Vertical scrolling
        if (relativeY < EDGE_SCROLL_THRESHOLD) {
            scrollY = -AUTO_SCROLL_SPEED; // Scroll up
        } else if (relativeY > scrollerHeight - EDGE_SCROLL_THRESHOLD) {
            scrollY = AUTO_SCROLL_SPEED; // Scroll down
        }

        // Horizontal scrolling
        if (relativeX < EDGE_SCROLL_THRESHOLD) {
            scrollX = -AUTO_SCROLL_SPEED; // Scroll left
        } else if (relativeX > scrollerWidth - EDGE_SCROLL_THRESHOLD) {
            scrollX = AUTO_SCROLL_SPEED; // Scroll right
        }

        // Start auto-scrolling if needed
        if (scrollY !== 0 || scrollX !== 0) {
            this.startAutoScroll(scrollX, scrollY);
        } else {
            this.stopAutoScroll();
        }
    }

    startAutoScroll(scrollX, scrollY) {
        // Check if already scrolling with same speed
        if (this.isAutoScrolling && this.autoScrollSpeedX === scrollX && this.autoScrollSpeedY === scrollY) {
            return;
        }

        this.isAutoScrolling = true;
        this.autoScrollSpeedX = scrollX;
        this.autoScrollSpeedY = scrollY;

        const scroll = () => {
            if (this.isAutoScrolling) {
                if (this.autoScrollSpeedY !== 0) {
                    this.virtualScroller.scrollTop += this.autoScrollSpeedY;
                }
                if (this.autoScrollSpeedX !== 0) {
                    this.virtualScroller.scrollLeft += this.autoScrollSpeedX;
                }
                this.autoScrollRaf = requestAnimationFrame(scroll);
            }
        };

        if (!this.autoScrollRaf) {
            this.autoScrollRaf = requestAnimationFrame(scroll);
        }
    }

    stopAutoScroll() {
        this.isAutoScrolling = false;
        this.autoScrollSpeedX = 0;
        this.autoScrollSpeedY = 0;
        if (this.autoScrollRaf) {
            cancelAnimationFrame(this.autoScrollRaf);
            this.autoScrollRaf = null;
        }
    }

    handleHexInput(hexChar) {
        if (this.selectedStart < 0 || this.selectedEnd < 0 || !this.fileBuffer) return;

        const min = Math.min(this.selectedStart, this.selectedEnd);
        const max = Math.max(this.selectedStart, this.selectedEnd);
        const hasSelectionRange = (this.selectedStart !== this.selectedEnd);

        // Initialize currentEditOffset if not set
        if (this.currentEditOffset < 0 || this.currentEditOffset < min || this.currentEditOffset > max) {
            this.currentEditOffset = min;
            this.currentEditNibble = 0;
        }

        // Use currentEditOffset for editing
        const editOffset = this.currentEditOffset;

        // Get current byte value
        let currentByte = this.dataView.getUint8(editOffset);
        const hexValue = parseInt(hexChar, 16);

        // Cyclic nibble update: State 0 = high nibble, State 1 = low nibble
        if (this.currentEditNibble === 0) {
            // Update high nibble (first digit) - State 0 -> State 1
            currentByte = (hexValue << 4) | (currentByte & 0x0F);
            this.currentEditNibble = 1; // Move to low nibble
        } else {
            // Update low nibble (second digit) - State 1 -> State 0
            currentByte = (currentByte & 0xF0) | hexValue;
            this.currentEditNibble = 0; // Cycle back to high nibble

            // After completing a byte, advance to next byte if in selection range
            if (hasSelectionRange) {
                this.currentEditOffset += 1;

                // Looping Logic: If currentEditOffset exceeds selection range, loop back to start
                if (this.currentEditOffset > max) {
                    this.currentEditOffset = min;
                }
            }
        }

        // Immediately update the byte
        this.updateByte(editOffset, currentByte);

        // If single byte selection, stay on same byte
        if (!hasSelectionRange) {
            this.currentEditOffset = editOffset;
        }

        // Do NOT clear the selection - keep the blue highlight active so user sees the loop happening
        // The selection range remains visible during looping block edit

        this.render();
        this.updateDataInspector();
    }

    handleAsciiInput(asciiChar) {
        if (this.selectedStart < 0 || this.selectedEnd < 0 || !this.fileBuffer) return;

        const min = Math.min(this.selectedStart, this.selectedEnd);
        const max = Math.max(this.selectedStart, this.selectedEnd);
        const hasSelectionRange = (this.selectedStart !== this.selectedEnd);

        // Initialize currentEditOffset if not set
        if (this.currentEditOffset < 0 || this.currentEditOffset < min || this.currentEditOffset > max) {
            this.currentEditOffset = min;
        }

        // Use currentEditOffset for editing
        const editOffset = this.currentEditOffset;

        // Get character code (clamp to 0-255)
        const charCode = Math.min(255, Math.max(0, asciiChar.charCodeAt(0)));

        // Update the byte immediately
        this.updateByte(editOffset, charCode);

        // Advance to next byte if in selection range
        if (hasSelectionRange) {
            this.currentEditOffset += 1;

            // Looping Logic: If currentEditOffset exceeds selection range, loop back to start
            if (this.currentEditOffset > max) {
                this.currentEditOffset = min;
            }
        } else {
            // If single byte selection, stay on same byte
            this.currentEditOffset = editOffset;
        }

        // Do NOT clear the selection - keep the blue highlight active so user sees the loop happening
        // The selection range remains visible during looping block edit

        this.render();
        this.updateDataInspector();
    }

    scrollSelectionIntoView() {
        if (!this.fileBuffer) return;

        // Determine which offset to use: currentEditOffset (for multi-selection) or selectedStart (for single byte)
        let targetOffset = -1;
        if (this.currentEditOffset >= 0) {
            targetOffset = this.currentEditOffset;
        } else if (this.selectedStart >= 0) {
            targetOffset = this.selectedStart;
        }

        if (targetOffset < 0) return;

        // Get the element for the target offset
        const selectorPrefix = this.currentEditColumn === 'ascii' ? '.ascii-char' : '.hex-byte';
        const element = this.virtualContent.querySelector(`${selectorPrefix}[data-offset="${targetOffset}"]`);

        if (!element) return;

        const elementRect = element.getBoundingClientRect();
        const scrollerRect = this.virtualScroller.getBoundingClientRect();
        const viewportHeight = scrollerRect.height;
        const viewportCenter = scrollerRect.top + viewportHeight / 2;

        // Check if element is in bottom 50% of viewport
        const elementCenter = elementRect.top + elementRect.height / 2;
        const isInBottomHalf = elementCenter > viewportCenter;

        if (isInBottomHalf) {
            // Calculate target scroll position to place selection in top 30-40% (safely above keyboard)
            const targetTop = elementRect.top - scrollerRect.top - (viewportHeight * 0.35); // 35% from top
            const currentScrollTop = this.virtualScroller.scrollTop;
            const newScrollTop = currentScrollTop + targetTop;

            // Smooth scroll to new position
            this.virtualScroller.scrollTo({
                top: Math.max(0, newScrollTop),
                behavior: 'smooth'
            });
        }
    }

    updateByte(offset, value) {
        if (offset < 0 || offset >= this.fileSize) return;

        // Save old value to history before changing
        const oldValue = this.dataView.getUint8(offset);
        if (oldValue !== value) {
            // Add to history
            this.addToHistory(offset, oldValue, value);
        }

        // Update the byte in the buffer
        this.dataView.setUint8(offset, value);

        // Mark as modified
        this.modifiedBytes.add(offset);

        // Update file state
        this.updateCurrentFileState();

        // Enable save button if there are modifications
        this.updateSaveButton();
    }

    addToHistory(offset, oldValue, newValue) {
        // Remove any history after current index (when doing new action after undo)
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        // Add new history entry
        this.history.push({
            offset: offset,
            oldValue: oldValue,
            newValue: newValue,
            timestamp: Date.now()
        });

        // Limit history size
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
            this.historyIndex = this.history.length - 1;
        } else {
            this.historyIndex = this.history.length - 1;
        }

        // Update file state's history
        this.updateCurrentFileState();

        this.updateHistoryButtons();
    }

    updateCurrentFileState() {
        // Update current file's state in fileStates map
        if (this.currentFile && this.fileBuffer) {
            let state = this.fileStates.get(this.currentFile);

            // Create state if it doesn't exist (shouldn't happen normally, but just in case)
            if (!state) {
                state = {
                    modifiedBytes: new Set(),
                    history: [],
                    historyIndex: -1,
                    originalBytes: new Map(this.originalBytes), // Copy from current
                    fileBuffer: this.fileBuffer.slice(0)
                };
                this.fileStates.set(this.currentFile, state);
            }

            // Update state with current values (always create new instances to avoid reference issues)
            state.modifiedBytes = new Set(this.modifiedBytes);
            state.history = JSON.parse(JSON.stringify(this.history));
            state.historyIndex = this.historyIndex;
            state.originalBytes = new Map(this.originalBytes);
            state.fileBuffer = this.fileBuffer.slice(0); // Copy current buffer
        }
    }

    handleUndo() {
        if (this.historyIndex < 0 || !this.fileBuffer) return;

        const entry = this.history[this.historyIndex];
        if (entry) {
            // Restore old value
            this.dataView.setUint8(entry.offset, entry.oldValue);

            // If value is back to original, remove from modified set
            // Otherwise keep it in modified set
            const originalValue = this.getOriginalByteValue(entry.offset);
            if (entry.oldValue === originalValue) {
                this.modifiedBytes.delete(entry.offset);
            } else {
                this.modifiedBytes.add(entry.offset);
            }

            this.historyIndex--;
            this.updateCurrentFileState();
            this.updateHistoryButtons();
            this.updateSaveButton();
            this.render();
        }
    }

    handleRedo() {
        if (this.historyIndex >= this.history.length - 1 || !this.fileBuffer) return;

        this.historyIndex++;
        const entry = this.history[this.historyIndex];
        if (entry) {
            // Apply new value
            this.dataView.setUint8(entry.offset, entry.newValue);

            // Mark as modified
            this.modifiedBytes.add(entry.offset);

            this.updateCurrentFileState();
            this.updateHistoryButtons();
            this.updateSaveButton();
            this.render();
        }
    }

    getOriginalByteValue(offset) {
        return this.originalBytes.get(offset) ?? this.dataView.getUint8(offset);
    }

    // Helper function to convert ArrayBuffer to Base64
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    updateHistoryButtons() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');

        if (undoBtn) {
            undoBtn.disabled = this.historyIndex < 0;
        }

        if (redoBtn) {
            redoBtn.disabled = this.historyIndex >= this.history.length - 1;
        }
    }

    updateSaveButton() {
        const saveBtn = document.getElementById('saveBtn');
        if (saveBtn) {
            saveBtn.disabled = this.modifiedBytes.size === 0;
        }
    }

    handleSaveFile() {
        if (!this.fileBuffer || this.modifiedBytes.size === 0) return;

        // Get the current file name from the active tab
        const activeTab = document.querySelector('.tab.active');
        let fileName = 'file.bin';
        if (activeTab) {
            const tabNameElement = activeTab.querySelector('.tab-name');
            if (tabNameElement) {
                fileName = tabNameElement.textContent.trim();
                // Remove ellipsis if present
                if (fileName.endsWith('...')) {
                    // Try to get original filename from files map
                    const fileId = activeTab.dataset.file;
                    // For now, use the tab name
                    fileName = fileName.replace('...', '');
                }
            }
        }

        // Check if Android interface is available
        if (window.Android && typeof window.Android.saveFile === 'function') {
            // Android mode: Use JavaScript interface to save file
            try {
                // Convert buffer to Base64
                const base64 = this.arrayBufferToBase64(this.fileBuffer);

                // Save file via Android bridge
                window.Android.saveFile(base64, fileName, 'application/octet-stream');
                // The Kotlin backend handles the Toast message ("Saved to Downloads...")
            } catch (error) {
                console.error('Error saving file via Android interface:', error);
                this.showToast('Error saving file: ' + error.message);
            }
        } else {
            // Desktop mode: Use Blob/Anchor tag download (fallback)
            const blob = new Blob([this.fileBuffer], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);

            // Create download link
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Clean up
            URL.revokeObjectURL(url);
        }

        // Keep modified bytes and save button active after save
        // Don't clear modifiedBytes or disable save button
    }

    scrollToOffset(offset) {
        const row = Math.floor(offset / this.bytesPerRow);
        const rowTop = row * this.rowHeight;
        const rowBottom = rowTop + this.rowHeight;
        const scrollerTop = this.virtualScroller.scrollTop;
        const scrollerBottom = scrollerTop + this.virtualScroller.clientHeight;

        if (rowTop < scrollerTop) {
            this.virtualScroller.scrollTop = rowTop;
        } else if (rowBottom > scrollerBottom) {
            this.virtualScroller.scrollTop = rowBottom - this.virtualScroller.clientHeight;
        }
    }

    formatOffset(offset) {
        return offset.toString(16).toUpperCase().padStart(8, '0');
    }

    formatByte(byte) {
        return byte.toString(16).toUpperCase().padStart(2, '0');
    }

    getAsciiChar(byte) {
        if (byte >= 32 && byte <= 126) {
            return String.fromCharCode(byte);
        }
        return '.';
    }

    // Toolbar handlers
    handleEdit() {
        if (this.selectedStart >= 0) {
            this.showToast('Edit mode - Byte at offset: ' + this.formatOffset(this.selectedStart));
        } else {
            this.showToast('Please select a byte to edit');
        }
    }

    handleCopy() {
        if (this.selectedStart >= 0 && this.selectedEnd >= 0) {
            const min = Math.min(this.selectedStart, this.selectedEnd);
            const max = Math.max(this.selectedStart, this.selectedEnd);
            const length = max - min + 1;
            const bytes = new Uint8Array(this.fileBuffer, min, length);
            const hexString = Array.from(bytes).map(b => this.formatByte(b)).join(' ');
            navigator.clipboard.writeText(hexString).then(() => {
                this.showToast('Copied to clipboard');
            });
        } else {
            this.showToast('Please select bytes to copy');
        }
    }

    handleCut() {
        this.handleCopy();
        // In a real implementation, you would mark bytes for deletion
    }

    handlePaste() {
        navigator.clipboard.readText().then(text => {
            // Parse hex string and paste
            this.showToast('Paste functionality - Clipboard: ' + text.substring(0, 50));
        }).catch(() => {
            this.showToast('Could not read from clipboard');
        });
    }

    handleDelete() {
        if (this.selectedStart >= 0 && this.selectedEnd >= 0) {
            this.showConfirm('Delete selected bytes?', (confirmed) => {
                if (confirmed) {
                    // In a real implementation, you would delete the bytes
                    this.selectedStart = -1;
                    this.selectedEnd = -1;
                    this.render();
                }
            });
        } else {
            this.showToast('Please select bytes to delete');
        }
    }

    handleClose() {
        this.showConfirm('Close current file?', (confirmed) => {
            if (confirmed) {
                // In a real implementation, close the file
                this.fileBuffer = null;
                this.fileSize = 0;
                this.totalRows = 0;
                this.selectedStart = -1;
                this.selectedEnd = -1;
                this.virtualContent.innerHTML = '';
            }
        });
    }

    gotoStart() {
        this.virtualScroller.scrollTop = 0;
        this.selectByte(0);
    }

    gotoEnd() {
        if (this.fileSize > 0) {
            const lastOffset = this.fileSize - 1;
            const row = Math.floor(lastOffset / this.bytesPerRow);
            this.virtualScroller.scrollTop = row * this.rowHeight;
            this.selectByte(lastOffset);
        }
    }

    handleJump() {
        this.showPrompt('Jump to offset (hex):', '0', (offset) => {
            if (offset) {
                const parsed = parseInt(offset, 16);
                if (!isNaN(parsed) && parsed >= 0 && parsed < this.fileSize) {
                    this.selectByte(parsed);
                } else {
                    this.showToast('Invalid offset');
                }
            }
        });
    }

    handleNext() {
        // Find next occurrence of selected pattern
        if (this.selectedStart >= 0) {
            const startByte = this.dataView.getUint8(this.selectedStart);
            for (let i = this.selectedStart + 1; i < this.fileSize; i++) {
                if (this.dataView.getUint8(i) === startByte) {
                    this.selectByte(i);
                    return;
                }
            }
            this.showToast('No more occurrences found');
        } else {
            this.showToast('Please select a byte first');
        }
    }

    handlePrev() {
        // Find previous occurrence of selected pattern
        if (this.selectedStart >= 0) {
            const startByte = this.dataView.getUint8(this.selectedStart);
            for (let i = this.selectedStart - 1; i >= 0; i--) {
                if (this.dataView.getUint8(i) === startByte) {
                    this.selectByte(i);
                    return;
                }
            }
            this.showToast('No previous occurrences found');
        } else {
            this.showToast('Please select a byte first');
        }
    }

    handleSearch() {
        this.showPrompt('Search (hex or text):', '', (query) => {
            if (query) {
                // Simple search implementation
                this.showToast('Searching for: ' + query);
            }
        });
    }

    handleMenu() {
        this.showToast('Menu');
    }

    handleSettings() {
        this.showToast('Settings');
    }

    removeTab(fileId) {
        const tab = document.querySelector(`[data-file="${fileId}"]`);
        if (tab) {
            tab.remove();
        }
        this.files.delete(fileId);

        // If this was the current file, switch to another or clear
        if (this.currentFile === fileId) {
            const remainingTabs = document.querySelectorAll('.tab');
            if (remainingTabs.length > 0) {
                const firstTab = remainingTabs[0];
                this.switchTab(firstTab.dataset.file);
            } else {
                this.fileBuffer = null;
                this.fileSize = 0;
                this.totalRows = 0;
                this.selectedStart = -1;
                this.selectedEnd = -1;
                this.virtualContent.innerHTML = '';
            }
        }
    }

    toggleDataInspector() {
        const dataInspector = document.getElementById('dataInspector');
        const sidebarOverlay = document.getElementById('sidebarOverlay');

        if (dataInspector) {
            const isOpen = dataInspector.classList.contains('open');
            if (isOpen) {
                this.closeDataInspector();
            } else {
                dataInspector.classList.add('open');
                if (sidebarOverlay) sidebarOverlay.classList.add('show');
                this.updateDataInspector();
                this.updateDataInspectorVisibility();
            }
        }
    }

    closeDataInspector() {
        const dataInspector = document.getElementById('dataInspector');
        const sidebarOverlay = document.getElementById('sidebarOverlay');

        if (dataInspector) dataInspector.classList.remove('open');
        if (sidebarOverlay) sidebarOverlay.classList.remove('show');
    }

    updateDataInspectorVisibility() {
        const dataInspector = document.getElementById('dataInspector');
        if (!dataInspector) return;

        const hasFile = this.fileBuffer !== null && this.fileSize > 0;
        const header = dataInspector.querySelector('.data-inspector-header');
        const nav = dataInspector.querySelector('.data-inspector-nav');
        const footer = dataInspector.querySelector('.data-inspector-footer');

        if (header) {
            header.style.display = hasFile ? 'flex' : 'none';
        }
        if (nav) {
            // Always show nav when file is loaded - simple approach
            if (hasFile) {
                nav.style.display = 'flex';
                nav.style.visibility = 'visible';
                nav.style.opacity = '1';
                nav.style.height = 'auto';
            } else {
                nav.style.display = 'none';
            }
        }
        if (footer) {
            footer.style.display = hasFile ? 'block' : 'none';
        }
    }

    updateDataInspector() {
        const content = document.getElementById('inspectorContent');
        this.updateDataInspectorVisibility();

        if (!content || !this.fileBuffer || this.selectedStart < 0) {
            if (content) {
                content.innerHTML = ''; // Empty white panel
            }
            return;
        }

        const min = Math.min(this.selectedStart, this.selectedEnd);
        const max = Math.max(this.selectedStart, this.selectedEnd);
        const byteCount = max - min + 1;
        const isLittleEndian = true; // Always use little endian

        // Calculate row and position
        const row = Math.floor(min / this.bytesPerRow);
        const col = min % this.bytesPerRow;
        const offsetHex = this.formatOffset(min);

        let html = '';

        // Show current position/offset
        html += `<div class="data-item selected">
            <span class="data-label">Offset:</span>
            <span class="data-value">${offsetHex} (Row ${row + 1}, Col ${col + 1})</span>
        </div>`;

        // Byte count / Size
        html += `<div class="data-item">
            <span class="data-label">Size:</span>
            <span class="data-value">${byteCount} byte${byteCount !== 1 ? 's' : ''}</span>
        </div>`;

        // Is zero check
        let allZero = true;
        for (let i = 0; i < byteCount; i++) {
            if (this.dataView.getUint8(min + i) !== 0) {
                allZero = false;
                break;
            }
        }
        html += `<div class="data-item">
            <span class="data-label">Is Zero:</span>
            <span class="data-value">${allZero ? 'Yes' : 'No'}</span>
        </div>`;

        // Is printable (for single byte)
        if (byteCount === 1) {
            const byte = this.dataView.getUint8(min);
            const isPrintable = byte >= 32 && byte <= 126;
            const isControl = byte < 32 || byte === 127;
            html += `<div class="data-item">
                <span class="data-label">Type:</span>
                <span class="data-value">${isPrintable ? 'Printable' : isControl ? 'Control' : 'Extended'}</span>
            </div>`;
        }

        // Sum of bytes
        let sum = 0;
        for (let i = 0; i < byteCount; i++) {
            sum += this.dataView.getUint8(min + i);
        }
        html += `<div class="data-item">
            <span class="data-label">Sum:</span>
            <span class="data-value">${sum}</span>
        </div>`;

        // Average (for multiple bytes)
        if (byteCount > 1) {
            const avg = Math.round((sum / byteCount) * 100) / 100;
            html += `<div class="data-item">
                <span class="data-label">Average:</span>
                <span class="data-value">${avg}</span>
            </div>`;
        }

        // Min/Max values (for multiple bytes)
        if (byteCount > 1) {
            let minVal = 255, maxVal = 0;
            for (let i = 0; i < byteCount; i++) {
                const val = this.dataView.getUint8(min + i);
                if (val < minVal) minVal = val;
                if (val > maxVal) maxVal = val;
            }
            html += `<div class="data-item">
                <span class="data-label">Min/Max:</span>
                <span class="data-value">${minVal} / ${maxVal}</span>
            </div>`;
        }

        // Character code point (for single byte)
        if (byteCount === 1) {
            const byte = this.dataView.getUint8(min);
            html += `<div class="data-item">
                <span class="data-label">Code Point:</span>
                <span class="data-value">U+${byte.toString(16).toUpperCase().padStart(4, '0')}</span>
            </div>`;
        }

        // Bitwise NOT (for single byte)
        if (byteCount === 1) {
            const byte = this.dataView.getUint8(min);
            const notByte = (~byte) & 0xFF;
            html += `<div class="data-item">
                <span class="data-label">NOT (~):</span>
                <span class="data-value">${this.formatByte(notByte)}</span>
            </div>`;
        }

        // Memory position info
        const filePercent = ((min / this.fileSize) * 100).toFixed(2);
        html += `<div class="data-item">
            <span class="data-label">Position:</span>
            <span class="data-value">${filePercent}% of file</span>
        </div>`;

        // Binary (8 bit) - only for single byte
        if (byteCount === 1) {
            const byte = this.dataView.getUint8(min);
            const binary = byte.toString(2).padStart(8, '0');
            html += `<div class="data-item selected">
                <span class="data-label">Binary (8 bit):</span>
                <span class="data-value">${binary}</span>
            </div>`;
        }

        // Integers
        const intTypes = [
            { name: 'Int8', size: 1, signed: true },
            { name: 'UInt8', size: 1, signed: false },
            { name: 'Int16', size: 2, signed: true },
            { name: 'UInt16', size: 2, signed: false },
            { name: 'Int24', size: 3, signed: true },
            { name: 'UInt24', size: 3, signed: false },
            { name: 'Int32', size: 4, signed: true },
            { name: 'UInt32', size: 4, signed: false },
            { name: 'Int64', size: 8, signed: true },
            { name: 'UInt64', size: 8, signed: false }
        ];

        for (const type of intTypes) {
            if (byteCount >= type.size) {
                try {
                    let value;
                    if (type.size === 1) {
                        value = type.signed ? this.dataView.getInt8(min) : this.dataView.getUint8(min);
                    } else if (type.size === 2) {
                        value = type.signed ?
                            (isLittleEndian ? this.dataView.getInt16(min, true) : this.dataView.getInt16(min, false)) :
                            (isLittleEndian ? this.dataView.getUint16(min, true) : this.dataView.getUint16(min, false));
                    } else if (type.size === 4) {
                        value = type.signed ?
                            (isLittleEndian ? this.dataView.getInt32(min, true) : this.dataView.getInt32(min, false)) :
                            (isLittleEndian ? this.dataView.getUint32(min, true) : this.dataView.getUint32(min, false));
                    } else if (type.size === 8) {
                        value = type.signed ?
                            (isLittleEndian ? this.dataView.getBigInt64(min, true) : this.dataView.getBigInt64(min, false)) :
                            (isLittleEndian ? this.dataView.getBigUint64(min, true) : this.dataView.getBigUint64(min, false));
                    } else {
                        // 24-bit (3 bytes) - manual calculation
                        let bytes = [];
                        for (let i = 0; i < 3; i++) {
                            bytes.push(this.dataView.getUint8(min + (isLittleEndian ? i : 2 - i)));
                        }
                        value = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
                        if (type.signed && value >= 0x800000) {
                            value = value - 0x1000000;
                        }
                    }

                    const displayValue = value.toString();

                    html += `<div class="data-item">
                        <span class="data-label">${type.name}:</span>
                        <span class="data-value">${displayValue}</span>
                    </div>`;
                } catch (e) {
                    // Skip error values - don't show them
                }
            }
        }

        // Hex string representation (always available)
        let hexString = '';
        for (let i = 0; i < Math.min(byteCount, 16); i++) {
            hexString += this.formatByte(this.dataView.getUint8(min + i));
            if (i < Math.min(byteCount, 16) - 1) hexString += ' ';
        }
        if (byteCount > 16) hexString += '...';
        html += `<div class="data-item">
            <span class="data-label">Hex:</span>
            <span class="data-value">${hexString}</span>
        </div>`;

        // Decimal representation (always available)
        if (byteCount === 1) {
            const byte = this.dataView.getUint8(min);
            html += `<div class="data-item">
                <span class="data-label">Decimal:</span>
                <span class="data-value">${byte}</span>
            </div>`;
        }

        // Octal representation (always available)
        if (byteCount === 1) {
            const byte = this.dataView.getUint8(min);
            html += `<div class="data-item">
                <span class="data-label">Octal:</span>
                <span class="data-value">${byte.toString(8).padStart(3, '0')}</span>
            </div>`;
        }

        // Bit count and parity (always available for single byte)
        if (byteCount === 1) {
            const byte = this.dataView.getUint8(min);
            const bitCount = byte.toString(2).split('1').length - 1;
            const parity = bitCount % 2 === 0 ? 'Even' : 'Odd';
            html += `<div class="data-item">
                <span class="data-label">Bits set:</span>
                <span class="data-value">${bitCount} (${parity} parity)</span>
            </div>`;
        }

        // Character encodings
        if (byteCount >= 2) {
            const char16 = isLittleEndian ?
                this.dataView.getUint16(min, true) :
                this.dataView.getUint16(min, false);
            html += `<div class="data-item">
                <span class="data-label">WideChar / char16_t:</span>
                <span class="data-value">${String.fromCharCode(char16)}</span>
            </div>`;
        }

        // RGB Color (3 bytes)
        if (byteCount >= 3) {
            const r = this.dataView.getUint8(min);
            const g = this.dataView.getUint8(min + 1);
            const b = this.dataView.getUint8(min + 2);
            html += `<div class="data-item">
                <span class="data-label">RGB Color:</span>
                <span class="data-value">rgb(${r}, ${g}, ${b})</span>
            </div>`;
        }

        // Floating point - only show if valid
        if (byteCount >= 4) {
            try {
                const float32 = isLittleEndian ?
                    this.dataView.getFloat32(min, true) :
                    this.dataView.getFloat32(min, false);
                if (!isNaN(float32) && isFinite(float32)) {
                    html += `<div class="data-item">
                        <span class="data-label">Single (float32):</span>
                        <span class="data-value">${float32.toExponential()}</span>
                    </div>`;
                }
            } catch (e) { }
        }
        if (byteCount >= 8) {
            try {
                const float64 = isLittleEndian ?
                    this.dataView.getFloat64(min, true) :
                    this.dataView.getFloat64(min, false);
                if (!isNaN(float64) && isFinite(float64)) {
                    html += `<div class="data-item">
                        <span class="data-label">Double (float64):</span>
                        <span class="data-value">${float64.toExponential()}</span>
                    </div>`;
                }
            } catch (e) { }
        }

        // DOS time (2 bytes) - always calculable
        if (byteCount >= 2) {
            // DOS time (2 bytes)
            const dosTime = isLittleEndian ?
                this.dataView.getUint16(min, true) :
                this.dataView.getUint16(min, false);
            const hour = (dosTime >> 11) & 0x1F;
            const minute = (dosTime >> 5) & 0x3F;
            const second = (dosTime & 0x1F) * 2;
            html += `<div class="data-item">
                <span class="data-label">DOS time:</span>
                <span class="data-value">${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}</span>
            </div>`;
        }

        // GUID (16 bytes)
        if (byteCount >= 16) {
            let guidParts = [];
            guidParts.push(this.formatHexBytes(min, 4, isLittleEndian));
            guidParts.push(this.formatHexBytes(min + 4, 2, isLittleEndian));
            guidParts.push(this.formatHexBytes(min + 6, 2, isLittleEndian));
            guidParts.push(this.formatHexBytes(min + 8, 2, false));
            guidParts.push(this.formatHexBytes(min + 10, 6, false));
            html += `<div class="data-item">
                <span class="data-label">GUID:</span>
                <span class="data-value">{${guidParts.join('-')}}</span>
            </div>`;
        }

        content.innerHTML = html;
    }

    formatHexBytes(offset, count, littleEndian) {
        let bytes = [];
        for (let i = 0; i < count; i++) {
            const idx = littleEndian ? i : count - 1 - i;
            bytes.push(this.dataView.getUint8(offset + idx).toString(16).padStart(2, '0').toUpperCase());
        }
        return bytes.join('');
    }

    navigateSelection(direction) {
        if (!this.fileBuffer || this.selectedStart < 0) return;

        const min = Math.min(this.selectedStart, this.selectedEnd);
        const max = Math.max(this.selectedStart, this.selectedEnd);
        const size = max - min + 1;

        let newStart = min;
        let newEnd = max;

        switch (direction) {
            case 'first':
                newStart = 0;
                newEnd = size - 1;
                break;
            case 'prev':
                newStart = Math.max(0, min - 1);
                newEnd = newStart + size - 1;
                break;
            case 'next':
                newEnd = Math.min(this.fileSize - 1, max + 1);
                newStart = newEnd - size + 1;
                if (newStart < 0) {
                    newStart = 0;
                    newEnd = size - 1;
                }
                break;
            case 'last':
                newEnd = this.fileSize - 1;
                newStart = Math.max(0, newEnd - size + 1);
                break;
        }

        this.selectRange(newStart, newEnd);
        this.render();
        this.updateDataInspector();

        // Scroll to selection
        const row = Math.floor(newStart / this.bytesPerRow);
        const rowElement = document.querySelector(`[data-row="${row}"]`);
        if (rowElement) {
            rowElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    // Tool Helpers
    updateJoinFileList() {
        const list = document.getElementById('joinFileList');
        list.innerHTML = '';

        // Hide naming container if no files
        if (this.joinFiles.length === 0) {
            document.getElementById('joinOutputContainer').style.display = 'none';
        }

        this.joinFiles.forEach((file, index) => {
            const item = document.createElement('li');
            item.className = 'file-item';
            item.draggable = true;
            item.dataset.index = index;
            item.innerHTML = `
                <div class="file-info">
                    <span class="file-name-text">${file.name}</span>
                </div>
                <span class="remove-file" onclick="app.removeJoinFile(${index})">×</span>
            `;

            // Drag events
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', index);
                item.classList.add('dragging');
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                const draggingItem = list.querySelector('.dragging');
                if (draggingItem && draggingItem !== item) {
                    const rect = item.getBoundingClientRect();
                    const midpoint = rect.top + rect.height / 2;
                    if (e.clientY < midpoint) {
                        list.insertBefore(draggingItem, item);
                    } else {
                        list.insertBefore(draggingItem, item.nextSibling);
                    }
                }
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                this.syncJoinFilesFromDOM();
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
            });

            // Touch events for mobile hold and move
            let touchTimer;
            let startX, startY;

            item.addEventListener('touchstart', (e) => {
                const touch = e.touches[0];
                startX = touch.clientX;
                startY = touch.clientY;

                touchTimer = setTimeout(() => {
                    item.classList.add('dragging');
                    if (navigator.vibrate) navigator.vibrate(40); // Feedback
                }, 500); // 500ms for long press
            }, { passive: true });

            item.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const deltaX = Math.abs(touch.clientX - startX);
                const deltaY = Math.abs(touch.clientY - startY);

                if (!item.classList.contains('dragging')) {
                    // If moving significantly before long press, cancel drag to let browser scroll
                    if (deltaX > 8 || deltaY > 8) {
                        clearTimeout(touchTimer);
                    }
                    return;
                }

                // If dragging, prevent scroll and move item
                e.preventDefault();

                // Edge Auto-Scroll
                const listRect = list.getBoundingClientRect();
                const scrollThreshold = 40;
                const distFromTop = touch.clientY - listRect.top;
                const distFromBottom = listRect.bottom - touch.clientY;

                if (this.listScrollInterval) clearInterval(this.listScrollInterval);

                if (distFromTop < scrollThreshold || distFromBottom < scrollThreshold) {
                    const speed = distFromTop < scrollThreshold ? -10 : 10;
                    this.listScrollInterval = setInterval(() => {
                        list.scrollTop += speed;
                        this.handleItemReorderAtPoint(touch.clientX, touch.clientY, item, list);
                    }, 16);
                }

                this.handleItemReorderAtPoint(touch.clientX, touch.clientY, item, list);
            }, { passive: false });

            item.addEventListener('touchend', () => {
                clearTimeout(touchTimer);
                if (this.listScrollInterval) clearInterval(this.listScrollInterval);
                if (item.classList.contains('dragging')) {
                    item.classList.remove('dragging');
                    this.syncJoinFilesFromDOM();
                }
            });

            list.appendChild(item);
        });
    }

    handleItemReorderAtPoint(x, y, draggingItem, listContainer) {
        const target = document.elementFromPoint(x, y);
        const targetItem = target?.closest('.file-item');

        if (targetItem && targetItem !== draggingItem) {
            const rect = targetItem.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            if (y < midpoint) {
                listContainer.insertBefore(draggingItem, targetItem);
            } else {
                listContainer.insertBefore(draggingItem, targetItem.nextSibling);
            }
        }
    }

    syncJoinFilesFromDOM() {
        const list = document.getElementById('joinFileList');
        const items = Array.from(list.querySelectorAll('.file-item'));
        const newOrder = items.map(item => this.joinFiles[parseInt(item.dataset.index)]);
        this.joinFiles = newOrder;
        this.updateJoinFileList(); // Redraw correctly
    }

    removeJoinFile(index) {
        this.joinFiles.splice(index, 1);
        this.updateJoinFileList();
    }

    async processJoin() {
        if (this.joinFiles.length < 2) {
            this.showToast("Please select at least 2 files to join.");
            return;
        }

        const outputName = document.getElementById('joinOutputName').value.trim() || "merged_output.bin";

        try {
            const buffers = [];
            for (const file of this.joinFiles) {
                buffers.push(await file.arrayBuffer());
            }

            const totalLength = buffers.reduce((acc, buf) => acc + buf.byteLength, 0);
            const joined = new Uint8Array(totalLength);
            let offset = 0;
            for (const buf of buffers) {
                joined.set(new Uint8Array(buf), offset);
                offset += buf.byteLength;
            }

            this.downloadBlob(joined, outputName);
        } catch (err) {
            console.error(err);
            this.showToast("Error joining files: " + err.message);
        }
    }

    async processSplit() {
        if (!this.splitFile) {
            this.showToast("Please select a file to split.");
            return;
        }

        const sizeInput = document.getElementById('splitSizeValue');
        let sizeVal = parseInt(sizeInput.value);
        if (isNaN(sizeVal) || sizeInput.value.trim() === "") {
            sizeVal = 65536; // Default from placeholder
        }

        const unitVal = parseInt(document.getElementById('splitSizeUnit').value);
        const chunkSize = sizeVal * unitVal;
        const baseName = document.getElementById('splitBaseName').value.trim() || 'split';

        if (isNaN(chunkSize) || chunkSize <= 0) {
            this.showToast("Invalid split size.");
            return;
        }

        try {
            const buffer = await this.splitFile.arrayBuffer();
            const totalChunks = Math.ceil(buffer.byteLength / chunkSize);

            if (totalChunks > 50) {
                this.showConfirm(`This will create ${totalChunks} files. Continue?`, (confirmed) => {
                    if (confirmed) this.executeSplit(buffer, chunkSize, totalChunks, baseName);
                });
            } else {
                this.executeSplit(buffer, chunkSize, totalChunks, baseName);
            }
        } catch (err) {
            console.error(err);
            this.showToast("Error splitting file: " + err.message);
        }
    }

    async executeSplit(buffer, chunkSize, totalChunks, baseName) {
        // Find extension if exists
        const lastDotIndex = baseName.lastIndexOf('.');
        let namePart = baseName;
        let extPart = '';

        if (lastDotIndex > 0) {
            namePart = baseName.substring(0, lastDotIndex);
            extPart = baseName.substring(lastDotIndex); // includes the dot
        }

        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, buffer.byteLength);
            const chunk = buffer.slice(start, end);

            const fileName = `${namePart}(${i})${extPart}`;

            this.downloadBlob(chunk, fileName);

            if (totalChunks > 1) await new Promise(r => setTimeout(r, 200));
        }
    }

    downloadBlob(data, fileName, subDir = "") {
        const fullFileName = subDir ? `${subDir}/${fileName}` : fileName;
        const displayPath = subDir ? `Downloads/AssetEditor/${subDir}` : `Downloads/AssetEditor`;

        if (window.Android && typeof window.Android.saveFile === 'function') {
            try {
                const base64 = this.arrayBufferToBase64(data);
                window.Android.saveFile(base64, fullFileName, 'application/octet-stream');
                // Notification handled by Android
            } catch (err) {
                console.error(err);
                this.showToast("Error saving via Android: " + err.message);
            }
        } else {
            // Desktop fallback
            const blob = new Blob([data], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName; // Browsers don't support subdirs in download attribute easily
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    // --- New Hex Tools ---

    async processStrings() {
        if (!this.stringsFile) {
            this.showToast("Please select a file.");
            return;
        }
        const minLen = parseInt(document.getElementById('minStringLength').value) || 4;
        try {
            const buffer = await this.stringsFile.arrayBuffer();
            const view = new DataView(buffer);
            const results = [];
            let current = "";
            let startOffset = -1;

            for (let i = 0; i < view.byteLength; i++) {
                const b = view.getUint8(i);
                if (b >= 32 && b <= 126) {
                    if (startOffset === -1) startOffset = i;
                    current += String.fromCharCode(b);
                } else {
                    if (current.length >= minLen) {
                        results.push({ offset: startOffset, text: current });
                    }
                    current = "";
                    startOffset = -1;
                }
            }
            if (current.length >= minLen) {
                results.push({ offset: startOffset, text: current });
            }

            const list = document.getElementById('stringList');
            const countLabel = document.getElementById('stringCount');
            const container = document.getElementById('stringResults');

            countLabel.textContent = results.length;
            list.innerHTML = results.slice(0, 5000).map(r => `
                <div class="string-item">
                    <span class="string-offset">${this.formatOffset(r.offset)}</span>
                    <span class="string-text">${this.escapeHtml(r.text)}</span>
                </div>
            `).join('');
            if (results.length > 5000) {
                list.innerHTML += `<div class="string-item" style="justify-content:center; color:#999;">... Showing first 5000 strings ...</div>`;
            }
            container.style.display = 'block';
        } catch (e) {
            this.showToast("Error: " + e.message);
        }
    }

    async processHashes() {
        if (!this.hashFile) {
            this.showToast("Please select a file.");
            return;
        }
        try {
            const buffer = await this.hashFile.arrayBuffer();

            // SHA-256
            const sha256Buffer = await crypto.subtle.digest('SHA-256', buffer);
            const sha256Hex = Array.from(new Uint8Array(sha256Buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            document.getElementById('hashSHA256').textContent = sha256Hex.toUpperCase();

            // SHA-1
            const sha1Buffer = await crypto.subtle.digest('SHA-1', buffer);
            const sha1Hex = Array.from(new Uint8Array(sha1Buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            document.getElementById('hashSHA1').textContent = sha1Hex.toUpperCase();

            // CRC32
            const crc32 = this.calculateCRC32(new Uint8Array(buffer));
            document.getElementById('hashCRC32').textContent = (crc32 >>> 0).toString(16).toUpperCase().padStart(8, '0');

            document.getElementById('hashResults').style.display = 'block';
        } catch (e) {
            this.showToast("Error: " + e.message);
        }
    }

    calculateCRC32(data) {
        if (!window.crcTable) {
            let table = [];
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) {
                    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
                }
                table[n] = c;
            }
            window.crcTable = table;
        }
        let crc = 0 ^ (-1);
        for (let i = 0; i < data.length; i++) {
            crc = (crc >>> 8) ^ window.crcTable[(crc ^ data[i]) & 0xFF];
        }
        return (crc ^ (-1)) >>> 0;
    }

    convert(source) {
        const h = document.getElementById('convHex');
        const d = document.getElementById('convDec');
        const b = document.getElementById('convBin');
        const o = document.getElementById('convOct');
        const a = document.getElementById('convAscii');

        let val = 0;
        try {
            let raw = "";
            if (source === 'hex') {
                raw = h.value.replace('0x', '');
                if (!raw) return;
                val = parseInt(raw, 16);
            } else if (source === 'dec') {
                raw = d.value;
                if (!raw) return;
                val = parseInt(raw, 10);
            } else if (source === 'bin') {
                raw = b.value;
                if (!raw) return;
                val = parseInt(raw, 2);
            } else if (source === 'oct') {
                raw = o.value;
                if (!raw) return;
                val = parseInt(raw, 8);
            } else if (source === 'ascii') {
                raw = a.value;
                if (!raw) return;
                val = raw.charCodeAt(0);
            }

            if (isNaN(val)) return;

            if (source !== 'hex') h.value = '0x' + val.toString(16).toUpperCase();
            if (source !== 'dec') d.value = val.toString(10);
            if (source !== 'bin') b.value = val.toString(2).padStart(8, '0');
            if (source !== 'oct') o.value = val.toString(8);
            if (source !== 'ascii') a.value = val <= 65535 ? String.fromCharCode(val) : '?';
        } catch (e) { }
    }

    async processDiff() {
        if (!this.diffFileA || !this.diffFileB) {
            this.showToast("Please select both files.");
            return;
        }
        try {
            const bufA = await this.diffFileA.arrayBuffer();
            const bufB = await this.diffFileB.arrayBuffer();
            const viewA = new Uint8Array(bufA);
            const viewB = new Uint8Array(bufB);
            const maxLen = Math.max(viewA.length, viewB.length);
            const minLen = Math.min(viewA.length, viewB.length);

            const hunks = [];
            let currentHunk = null;

            for (let i = 0; i < maxLen; i++) {
                const valA = i < viewA.length ? viewA[i] : null;
                const valB = i < viewB.length ? viewB[i] : null;

                if (i >= minLen || valA !== valB) {
                    if (!currentHunk) {
                        currentHunk = {
                            start: i,
                            bytesA: [],
                            bytesB: []
                        };
                        hunks.push(currentHunk);
                    }
                    if (valA !== null) currentHunk.bytesA.push(valA);
                    if (valB !== null) currentHunk.bytesB.push(valB);
                } else {
                    currentHunk = null;
                }

                if (hunks.length >= 1000) break;
            }

            const list = document.getElementById('diffList');
            const countLabel = document.getElementById('diffCount');
            const container = document.getElementById('diffResults');

            countLabel.textContent = hunks.length + (hunks.length >= 1000 ? "+" : "");
            list.innerHTML = hunks.map(h => {
                const hexA = h.bytesA.map(b => this.formatByte(b)).join(' ');
                const hexB = h.bytesB.map(b => this.formatByte(b)).join(' ');

                const asciiA = h.bytesA.map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
                const asciiB = h.bytesB.map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');

                return `
                    <div class="diff-result-item">
                        <div class="diff-header">
                            <span>OFFSET: ${this.formatOffset(h.start)}</span>
                            <span>Length: ${h.bytesA.length} bytes</span>
                        </div>
                        <div class="diff-comparison">
                            <div class="diff-box a">
                                <span class="diff-label">File A</span>
                                <div class="diff-hex" style="word-break: break-all; font-size: 13px;">${hexA}</div>
                                <span class="diff-ascii">&quot;${this.escapeHtml(asciiA)}&quot;</span>
                            </div>
                            <div class="diff-arrow">→</div>
                            <div class="diff-box b">
                                <span class="diff-label">File B</span>
                                <div class="diff-hex" style="word-break: break-all; font-size: 13px;">${hexB}</div>
                                <span class="diff-ascii">&quot;${this.escapeHtml(asciiB)}&quot;</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            container.style.display = 'block';

            if (hunks.length > 0 && hunks[0].bytesA.length === maxLen && maxLen > 0) {
                this.showToast("No similarity found in the files you are trying to compare.");
            } else if (hunks.length === 0 && maxLen > 0) {
                this.showToast("The files are identical!");
            }
        } catch (e) {
            console.error(e);
            this.showToast("No similarity found in the files you are trying to compare.");
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ==========================================
    // UAsset Property Diff Methods
    // ==========================================

    /**
     * Attempt to parse both asset sets when files are loaded
     */
    async tryParseAssets() {
        if (this.uassetFileA) {
            try {
                this.parsedAssetA = await this.parseUAsset(this.uassetFileA, this.uexpFileA);
            } catch (e) {
                console.error('Failed to parse Asset A:', e);
                this.parsedAssetA = null;
            }
        }

        if (this.uassetFileB) {
            try {
                this.parsedAssetB = await this.parseUAsset(this.uassetFileB, this.uexpFileB);
            } catch (e) {
                console.error('Failed to parse Asset B:', e);
                this.parsedAssetB = null;
            }
        }
    }

    /**
     * Parse a UAsset file (and optional UExp) using UAssetBinaryReader from main.js
     */
    async parseUAsset(uassetFile, uexpFile = null) {
        const uassetBuffer = await uassetFile.arrayBuffer();
        let uexpBuffer = null;

        if (uexpFile) {
            uexpBuffer = await uexpFile.arrayBuffer();
        }

        // Parse header
        const headerReader = new UAssetHeaderReader(uassetBuffer);
        const header = headerReader.read();

        // Parse name map
        const nameMapReader = new UAssetNameMapReader(uassetBuffer, header.fileVersionUE4);
        const nameSectionEnd = header.importOffset > 0 ? header.importOffset : header.exportOffset;
        const nameMap = nameMapReader.read(header.nameOffset, header.nameCount, nameSectionEnd);

        // Parse imports and exports
        const objectReader = new UAssetObjectReader(uassetBuffer, nameMap, header.fileVersionUE4);
        objectReader.setOffset(header.importOffset);
        const imports = objectReader.readImports(header.importCount);

        objectReader.setOffset(header.exportOffset);
        const exports = objectReader.readExports(header.exportCount);

        // Set up property reader with uexp if available
        const propertyReader = new UAssetPropertyReader(
            uassetBuffer,
            nameMap,
            imports,
            exports,
            header.totalHeaderSize,
            uexpBuffer,
            false // enableDebug
        );

        // Parse properties for each export
        const parsedExports = [];
        for (let i = 0; i < exports.length; i++) {
            const exp = exports[i];
            const exportData = {
                index: i,
                name: exp.objectName,
                classIndex: exp.classIndex,
                serialOffset: exp.serialOffset,
                serialSize: exp.serialSize,
                properties: []
            };

            try {
                propertyReader.setOffset(exp.serialOffset);
                const endOffset = exp.serialOffset + exp.serialSize;
                exportData.properties = propertyReader.readProperties(endOffset);
            } catch (e) {
                console.warn(`Failed to parse properties for export ${i} (${exp.objectName}):`, e.message);
                exportData.error = e.message;
            }

            parsedExports.push(exportData);
        }

        return {
            header,
            nameMap,
            imports,
            exports: parsedExports
        };
    }

    /**
     * Main function to process property diff between two assets (compares all exports)
     */
    async processPropertyDiff() {
        // Require all 4 files: uasset + uexp for both sets
        // Require all 4 files: uasset + uexp for both sets
        if (!this.uassetFileA || !this.uexpFileA) {
            this.showToast('Please select both .uasset and .uexp files for Original File.');
            return;
        }

        // Validate Filename Match for Set A
        const nameA_uasset = this.uassetFileA.name.split('.').slice(0, -1).join('.');
        const nameA_uexp = this.uexpFileA.name.split('.').slice(0, -1).join('.');
        if (nameA_uasset.toLowerCase() !== nameA_uexp.toLowerCase()) {
            this.showToast(`Error: Original files must match! (${nameA_uasset}.uasset & ${nameA_uexp}.uexp)`);
            return;
        }

        if (!this.uassetFileB || !this.uexpFileB) {
            this.showToast('Please select both .uasset and .uexp files for Modified File.');
            return;
        }

        // Validate Filename Match for Set B
        const nameB_uasset = this.uassetFileB.name.split('.').slice(0, -1).join('.');
        const nameB_uexp = this.uexpFileB.name.split('.').slice(0, -1).join('.');
        if (nameB_uasset.toLowerCase() !== nameB_uexp.toLowerCase()) {
            this.showToast(`Error: Modified files must match! (${nameB_uasset}.uasset & ${nameB_uexp}.uexp)`);
            return;
        }
        if (!this.parsedAssetA || !this.parsedAssetB) {
            this.showToast('Error parsing assets. Please check the files.');
            return;
        }

        const resultsContainer = document.getElementById('propertyDiffResults');
        resultsContainer.innerHTML = `
            <div class="diff-loading">
                <div class="diff-loading-spinner"></div>
                <span>Comparing properties...</span>
            </div>
        `;

        // Give UI time to update
        await new Promise(r => setTimeout(r, 50));

        try {
            // Compare all matching exports
            const namesA = new Map(this.parsedAssetA.exports.map(e => [e.name, e]));
            const namesB = new Map(this.parsedAssetB.exports.map(e => [e.name, e]));

            const allNames = new Set([...namesA.keys(), ...namesB.keys()]);

            let exportsToCompare = [];
            allNames.forEach(name => {
                exportsToCompare.push({
                    name,
                    exportA: namesA.get(name) || null,
                    exportB: namesB.get(name) || null
                });
            });

            // Perform property comparison
            this.propertyDiffResults = [];
            let stats = { modified: 0, added: 0, removed: 0 };

            for (const { name, exportA, exportB } of exportsToCompare) {
                const propsA = exportA?.properties || [];
                const propsB = exportB?.properties || [];

                const diffed = this.comparePropertyLists(propsA, propsB, name);
                this.propertyDiffResults.push(...diffed.results);

                stats.modified += diffed.stats.modified;
                stats.added += diffed.stats.added;
                stats.removed += diffed.stats.removed;
            }

            // Render results
            this.renderPropertyDiffResults(stats);

            // Hide file selection, show "New Comparison" button
            const inputSection = document.getElementById('diffInputSection');
            const newCompBtn = document.getElementById('newComparisonBtn');
            if (inputSection) inputSection.style.display = 'none';
            if (newCompBtn) newCompBtn.style.display = 'block';

        } catch (e) {
            console.error('Property diff error:', e);
            resultsContainer.innerHTML = `
                <div class="property-diff-empty">
                    <h3>Error</h3>
                    <p>${this.escapeHtml(e.message)}</p>
                </div>
            `;
        }
    }

    /**
     * Reset property diff view to allow new comparison
     */
    resetPropertyDiff() {
        const inputSection = document.getElementById('diffInputSection');
        const newCompBtn = document.getElementById('newComparisonBtn');
        const results = document.getElementById('propertyDiffResults');
        const summary = document.getElementById('propDiffSummary');

        if (inputSection) inputSection.style.display = 'block';
        if (newCompBtn) newCompBtn.style.display = 'none';
        if (results) results.style.display = 'none';
        if (summary) summary.style.display = 'none';

        // File State Reset
        this.uassetFileA = null;
        this.uexpFileA = null;
        this.uassetFileB = null;
        this.uexpFileB = null;
        this.parsedAssetA = null;
        this.parsedAssetB = null;

        // Input Reset
        ['uassetInputA', 'uexpInputA', 'uassetInputB', 'uexpInputB'].forEach(id => {
            const input = document.getElementById(id);
            if (input) input.value = '';
        });

        // Label Reset
        const resetLabel = (id) => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = 'No file selected';
                el.style.color = '#555';
                el.style.fontStyle = 'italic';
            }
        };
        resetLabel('uassetFileNameA');
        resetLabel('uexpFileNameA');
        resetLabel('uassetFileNameB');
        resetLabel('uexpFileNameB');
    }

    /**
     * Compare two property lists and generate diff results
     */
    comparePropertyLists(propsA, propsB, exportName, parentPath = '', indent = 0) {
        const results = [];
        const stats = { modified: 0, added: 0, removed: 0 };

        // Build maps for quick lookup
        const mapA = new Map();
        const mapB = new Map();

        propsA.forEach((p, idx) => {
            const key = `${p.name}_${p.type}_${p.arrayIndex || 0}`;
            mapA.set(key, { prop: p, idx });
        });

        propsB.forEach((p, idx) => {
            const key = `${p.name}_${p.type}_${p.arrayIndex || 0}`;
            mapB.set(key, { prop: p, idx });
        });

        // Check all properties in A
        const processedKeys = new Set();

        for (const [key, { prop: propA }] of mapA) {
            processedKeys.add(key);
            const propBEntry = mapB.get(key);
            const fullPath = parentPath ? `${parentPath}.${propA.name}` : propA.name;

            if (!propBEntry) {
                // Property removed in B
                results.push({
                    exportName,
                    path: fullPath,
                    name: propA.name,
                    type: propA.type,
                    valueA: this.formatPropertyValue(propA),
                    valueB: null,
                    status: 'removed',
                    indent
                });
                stats.removed++;
            } else {
                // Property exists in both - compare values
                const propB = propBEntry.prop;
                const valA = this.formatPropertyValue(propA);
                const valB = this.formatPropertyValue(propB);

                const isEqual = this.deepCompareValues(propA.value, propB.value);

                results.push({
                    exportName,
                    path: fullPath,
                    name: propA.name,
                    type: propA.type,
                    valueA: valA,
                    valueB: valB,
                    status: isEqual ? 'unchanged' : 'modified',
                    indent
                });

                if (!isEqual) stats.modified++;

                // Recursively compare nested properties (structs, arrays)
                if (propA.type === 'StructProperty' && Array.isArray(propA.value)) {
                    const nested = this.comparePropertyLists(
                        propA.value,
                        propB.value || [],
                        exportName,
                        fullPath,
                        indent + 1
                    );
                    results.push(...nested.results);
                    stats.modified += nested.stats.modified;
                    stats.added += nested.stats.added;
                    stats.removed += nested.stats.removed;
                }

                if (propA.type === 'ArrayProperty' && Array.isArray(propA.value)) {
                    const arrayValA = propA.value;
                    const arrayValB = propB.value || [];
                    const maxLen = Math.max(arrayValA.length, arrayValB.length);

                    for (let i = 0; i < maxLen; i++) {
                        const itemA = arrayValA[i];
                        const itemB = arrayValB[i];
                        const itemPath = `${fullPath}[${i}]`;

                        if (itemA === undefined) {
                            results.push({
                                exportName,
                                path: itemPath,
                                name: `[${i}]`,
                                type: propA.innerType || 'Element',
                                valueA: null,
                                valueB: this.formatValue(itemB),
                                status: 'added',
                                indent: indent + 1
                            });
                            stats.added++;
                        } else if (itemB === undefined) {
                            results.push({
                                exportName,
                                path: itemPath,
                                name: `[${i}]`,
                                type: propA.innerType || 'Element',
                                valueA: this.formatValue(itemA),
                                valueB: null,
                                status: 'removed',
                                indent: indent + 1
                            });
                            stats.removed++;
                        } else if (typeof itemA === 'object' && Array.isArray(itemA)) {
                            // Nested struct in array
                            const nested = this.comparePropertyLists(
                                itemA,
                                itemB,
                                exportName,
                                itemPath,
                                indent + 1
                            );
                            results.push(...nested.results);
                            stats.modified += nested.stats.modified;
                            stats.added += nested.stats.added;
                            stats.removed += nested.stats.removed;
                        } else {
                            const isEqual = this.deepCompareValues(itemA, itemB);
                            if (!isEqual) {
                                results.push({
                                    exportName,
                                    path: itemPath,
                                    name: `[${i}]`,
                                    type: propA.innerType || 'Element',
                                    valueA: this.formatValue(itemA),
                                    valueB: this.formatValue(itemB),
                                    status: 'modified',
                                    indent: indent + 1
                                });
                                stats.modified++;
                            }
                        }
                    }
                }
            }
        }

        // Check for added properties in B
        // Check for added properties in B
        for (const [key, { prop: propB }] of mapB) {
            if (!processedKeys.has(key)) {
                const fullPath = parentPath ? `${parentPath}.${propB.name}` : propB.name;
                results.push({
                    exportName,
                    path: fullPath,
                    name: propB.name,
                    type: propB.type,
                    valueA: null,
                    valueB: this.formatPropertyValue(propB),
                    status: 'added',
                    indent
                });
                stats.added++;
            }
        }

        return { results, stats };
    }

    /**
     * Deep compare two values
     */
    deepCompareValues(a, b) {
        if (a === b) return true;
        if (a === null || b === null) return false;
        if (a === undefined || b === undefined) return false;

        if (typeof a !== typeof b) return false;

        if (a instanceof Uint8Array && b instanceof Uint8Array) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }

        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (!this.deepCompareValues(a[i], b[i])) return false;
            }
            return true;
        }

        if (typeof a === 'object') {
            const keysA = Object.keys(a);
            const keysB = Object.keys(b);
            if (keysA.length !== keysB.length) return false;

            for (const key of keysA) {
                if (!this.deepCompareValues(a[key], b[key])) return false;
            }
            return true;
        }

        return false;
    }

    /**
     * Format a property's value for display
     */
    formatPropertyValue(prop) {
        if (!prop) return null;
        return this.formatValue(prop.value);
    }

    /**
     * Format any value for display
     */
    formatValue(value) {
        if (value === null || value === undefined) return 'null';

        if (value instanceof Uint8Array) {
            if (value.length <= 16) {
                return Array.from(value).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            }
            return `[${value.length} bytes]`;
        }

        if (Array.isArray(value)) {
            if (value.length === 0) return '[]';
            if (value.length <= 3 && typeof value[0] !== 'object') {
                return `[${value.map(v => this.formatValue(v)).join(', ')}]`;
            }
            return `[Array: ${value.length} elements]`;
        }

        if (typeof value === 'object') {
            // Format common types
            if ('x' in value && 'y' in value) {
                if ('z' in value && 'w' in value) {
                    return `(${value.x.toFixed(2)}, ${value.y.toFixed(2)}, ${value.z.toFixed(2)}, ${value.w.toFixed(2)})`;
                }
                if ('z' in value) {
                    return `(${value.x.toFixed(2)}, ${value.y.toFixed(2)}, ${value.z.toFixed(2)})`;
                }
                return `(${value.x.toFixed(2)}, ${value.y.toFixed(2)})`;
            }
            if ('r' in value && 'g' in value && 'b' in value) {
                return `RGBA(${value.r}, ${value.g}, ${value.b}, ${value.a || 255})`;
            }

            // Generic object
            const entries = Object.entries(value);
            if (entries.length === 0) return '{}';
            if (entries.length <= 2) {
                return entries.map(([k, v]) => `${k}: ${this.formatValue(v)}`).join(', ');
            }
            return `{${entries.length} fields}`;
        }

        if (typeof value === 'number') {
            if (Number.isInteger(value)) return value.toString();
            return value.toFixed(4);
        }

        if (typeof value === 'boolean') {
            return value ? 'true' : 'false';
        }

        if (typeof value === 'string') {
            if (value.length > 50) {
                return `"${value.substring(0, 47)}..."`;
            }
            return `"${value}"`;
        }

        return String(value);
    }

    /**
     * Render the property diff results to the DOM (only shows changed properties)
     */
    renderPropertyDiffResults(stats) {
        const container = document.getElementById('propertyDiffResults');
        const summary = document.getElementById('propDiffSummary');
        const modifiedCountEl = document.getElementById('modifiedCount');

        if (!container) return;

        // Show container and summary
        container.style.display = 'block';

        // Update summary (only modified count)
        if (modifiedCountEl) modifiedCountEl.textContent = stats.modified;
        if (summary) summary.style.display = 'flex';

        // Filter out unchanged properties - only show modified, added, removed
        const changedResults = this.propertyDiffResults.filter(diff => diff.status !== 'unchanged');

        if (changedResults.length === 0) {
            container.innerHTML = `
                <div class="property-diff-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M9 12l2 2 4-4"/>
                        <circle cx="12" cy="12" r="10"/>
                    </svg>
                    <h3>No Differences Found</h3>
                    <p>The selected exports have identical properties.</p>
                </div>
            `;
            return;
        }

        // Build vertical card list - better for mobile/Android
        let html = '<div class="property-diff-list">';

        for (const diff of changedResults) {
            const indentStr = '  '.repeat(diff.indent);
            const statusClass = `diff-${diff.status}`;
            const statusLabel = diff.status === 'modified' ? 'Modified' :
                diff.status === 'added' ? 'Added' : 'Removed';

            // Generate Location Header
            let location = '';
            if (diff.path && diff.path !== diff.name) {
                // Determine parent path
                let parentPath = '';
                if (diff.path.endsWith('.' + diff.name)) {
                    parentPath = diff.path.substring(0, diff.path.length - diff.name.length - 1);
                } else if (diff.path.endsWith(diff.name)) { // e.g. Array[0]
                    parentPath = diff.path.substring(0, diff.path.length - diff.name.length);
                } else {
                    const lastDot = diff.path.lastIndexOf('.');
                    if (lastDot > 0) parentPath = diff.path.substring(0, lastDot);
                }

                // Format parent path for readability (e.g. "List[5]" -> "List Index 5")
                location = parentPath.replace(/\[(\d+)\]/g, ' #$1');
            }

            const locationHtml = `
                <div class="prop-card-location">
                    <span class="location-export">${this.escapeHtml(diff.exportName)}</span>
                    ${location ? `<span class="location-sep">›</span><span class="location-path">${this.escapeHtml(location)}</span>` : ''}
                </div>`;

            html += `
                <div class="property-diff-card ${statusClass}">
                    ${locationHtml}
                    <div class="prop-card-header">
                        <span class="prop-card-name">${this.escapeHtml(indentStr)}${this.escapeHtml(diff.name)}</span>
                        <span class="prop-card-badge">${statusLabel}</span>
                    </div>
                    <div class="prop-card-type">${this.escapeHtml(diff.type)}</div>
                    <div class="prop-card-values">
                        <div class="prop-card-value val-a">
                            <span class="prop-val-label">A:</span>
                            <span class="prop-val-content">${diff.valueA !== null ? this.escapeHtml(diff.valueA) : '—'}</span>
                        </div>
                        <div class="prop-card-value val-b">
                            <span class="prop-val-label">B:</span>
                            <span class="prop-val-content">${diff.valueB !== null ? this.escapeHtml(diff.valueB) : '—'}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        html += '</div>';
        container.innerHTML = html;
    }
}

// Initialize hex editor when DOM is ready
// Initialize hex editor when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new HexEditor();
});