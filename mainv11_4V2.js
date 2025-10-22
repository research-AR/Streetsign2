import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mindar-image-three';


document.addEventListener('DOMContentLoaded', () => {
    const start = async () => {

        // ============ MINDAR SETUP ============
        
        const arContainer = document.createElement('div');
        arContainer.id = 'ar-container';
        document.body.appendChild(arContainer);

        const mindarThree = new MindARThree({
            container: arContainer,
            imageTargetSrc: "./applications-20230306/applications/assets/targets/tabelafinish4.mind",
            maxTrack: 2, // Allow tracking of 2 targets
            filterMinCF: 0.0001, // Smoothing filter - increase for more stability
            filterBeta: 1000, // Reduce jitter - higher = smoother but less responsive
            warmupTolerance: 5, // Wait 5 frames before showing (reduces initial jitter)
            missTolerance: 5 // Keep showing for 5 frames after losing track
        });
        const {renderer, scene, camera} = mindarThree;

        // Position the AR canvas to fill the screen
        renderer.domElement.style.position = 'absolute';
        renderer.domElement.style.inset = '0';
        renderer.domElement.style.zIndex = '0';
        
        // Optimize renderer for better performance
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap pixel ratio for performance

        // Add lighting to the scene
        const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
        scene.add(light);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 1, 1);
        scene.add(directionalLight);

        // Create anchor points for AR tracking
        const anchor = mindarThree.addAnchor(0); // First target (main scenes)
        // Second anchor will be created later when needed (performance optimization)

        // --- HUD (screen-fixed arrows) ---
        injectHUDStyles();
        const { hud, prevB, nextB, label } = createHUD(); // appended to <body>, hidden by default
        hud.hidden = true;

        // --- models list + helpers ---
        const TOTAL = 4; // Total number of AR scenes (including guide scene)
        const models = new Array(TOTAL); // Array to store loaded 3D models
        const slotControllers = new Array(TOTAL);  // optional onEnter/onLeave per slot
        let index = 0; // Current active scene index
        let lastActive = -1; // Previously active scene index
        let targetFound = false; // Track if target is currently found
        
        // --- Second target system ---
        let viewedScenes = new Set(); // Track which scenes have been viewed
        let allScenesCompleted = false; // Track if all scenes are finished
        let secondTargetActive = false; // Track if second target is active
        let secondAnchor = null; // Second target anchor (created lazily for performance)
        let secondAnchorInitialized = false; // Track if second anchor has been set up
        
        // Second target scenes (similar structure to first target)
        const SECOND_TOTAL = 3; // Total number of scenes on second target
        const secondModels = new Array(SECOND_TOTAL); // Array to store second target models
        const secondSlotControllers = new Array(SECOND_TOTAL); // Controllers for second target slots
        let secondIndex = 0; // Current active scene on second target
        let secondLastActive = -1; // Previously active scene on second target
        let secondTargetFound = false; // Track if second target is currently visible

        const loader = new GLTFLoader();

        const countLoaded = () => models.filter(Boolean).length;
        const secondCountLoaded = () => secondModels.filter(Boolean).length;
        
        function updateLabel() {
        // show current slot number if that slot is loaded; otherwise 0
            if (index === 3 && allScenesCompleted) {
                label.textContent = `Guide: Find the Building`;
            } else {
                label.textContent = `${models[index] ? index + 1 : 0}/${TOTAL}`;
            }
        }
        
        // Track scene viewing and check for completion
        function markSceneViewed(sceneIndex) {
            // Only track first 3 scenes (not the guide scene)
            if (sceneIndex < 3) {
                viewedScenes.add(sceneIndex);
                console.log(`Scene ${sceneIndex + 1} viewed. Total viewed: ${viewedScenes.size}/3`);
                
                // Check if first 3 scenes are completed
                if (viewedScenes.size >= 3 && !allScenesCompleted) {
                    allScenesCompleted = true;
                    console.log('🎉 All content scenes completed! Guide scene unlocked.');
                    updateLabel();
                    updateNavigationButtons(); // Update buttons to enable scene 4
                }
            }
        }
        

        // ---------- OCCLUSION HELPERS ----------
        // Prepare content models for proper depth rendering
        function prepContent(root){
            root.traverse(o => {
                if (o.isMesh) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach(m => {
                        if (!m) return;
                        m.depthTest = true;
                        m.depthWrite = true;
                        m.colorWrite = true;
                    });
                    o.renderOrder = 1; // draw AFTER occluders
                }
            });
        }

        // Prepare occluder models (invisible depth writers)
        function prepOccluder(root){
            root.traverse(o => {
                if (o.isMesh) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach(m => {
                        if (!m) return;
                        // invisible but writes to depth buffer
                        m.colorWrite = false;
                        m.depthWrite = true;
                        m.depthTest  = true;
                        // nudge if you see z-fighting with the print
                        m.polygonOffset = true;
                        m.polygonOffsetFactor = -2;
                        m.polygonOffsetUnits  = -2;
                    });
                    o.renderOrder = 0; // draw BEFORE content
                }
            });
        }



        // Show/hide models based on current scene and handle scene transitions
        function applyVisibility() {
            models.forEach((m, i) => { if (m) m.visible = (i === index); });
            // fire leave/enter once per slot change
            if (lastActive !== index) {
                if (lastActive >= 0 && slotControllers[lastActive]?.onLeave) {
                    slotControllers[lastActive].onLeave();
                }
                if (slotControllers[index]?.onEnter) {
                    slotControllers[index].onEnter();
                }
                // Mark this scene as viewed
                if (models[index]) {
                    markSceneViewed(index);
                }
                
                // Initialize second anchor when reaching scene 4 (guide scene)
                if (index === 3 && !secondAnchorInitialized) {
                    console.log('📍 Initializing second target tracking (scene 4 reached)...');
                    initializeSecondAnchor();
                }
                
                lastActive = index;
            }
            
            updateLabel();
            updateNavigationButtons();
        }

        function nextLoaded(from, dir) {
        // walk circularly through fixed slots, skipping unloaded ones
            let i = from;
            for (let step = 0; step < TOTAL; step++) {
                i = (i + dir + TOTAL) % TOTAL;
                // Skip scene 4 (guide) if first 3 scenes not completed
                if (i === 3 && !allScenesCompleted) {
                    continue;
                }
                if (models[i]) return i;
            }
            return from; 
        }


        function showDelta(delta) {
            if (countLoaded() === 0) return;
            index = nextLoaded(index, delta >= 0 ? +1 : -1);
            applyVisibility();
        }

        // Set up navigation button handlers for first target
        const goPrev = () => {
            if (secondTargetActive) {
                secondShowDelta(-1);
            } else {
                showDelta(-1);
            }
        };
        const goNext = () => {
            if (secondTargetActive) {
                secondShowDelta(+1);
            } else {
                showDelta(+1);
            }
        };
        prevB.addEventListener('click', goPrev);
        nextB.addEventListener('click', goNext);
        
        // ============ SECOND TARGET NAVIGATION ============
        // Navigation functions for second target (similar to first target)
        function secondApplyVisibility() {
            secondModels.forEach((m, i) => { if (m) m.visible = (i === secondIndex); });
            // fire leave/enter once per slot change
            if (secondLastActive !== secondIndex) {
                if (secondLastActive >= 0 && secondSlotControllers[secondLastActive]?.onLeave) {
                    secondSlotControllers[secondLastActive].onLeave();
                }
                if (secondSlotControllers[secondIndex]?.onEnter) {
                    secondSlotControllers[secondIndex].onEnter();
                }
                secondLastActive = secondIndex;
            }
            
            secondUpdateLabel();
            secondUpdateNavigationButtons();
        }
        
        function secondNextLoaded(from, dir) {
            let i = from;
            for (let step = 0; step < SECOND_TOTAL; step++) {
                i = (i + dir + SECOND_TOTAL) % SECOND_TOTAL;
                if (secondModels[i]) return i;
            }
            return from;
        }
        
        function secondShowDelta(delta) {
            if (secondCountLoaded() === 0) return;
            secondIndex = secondNextLoaded(secondIndex, delta >= 0 ? +1 : -1);
            secondApplyVisibility();
        }
        
        function secondUpdateLabel() {
            label.textContent = `Building ${secondIndex + 1}/${SECOND_TOTAL}`;
        }
        
        function secondUpdateNavigationButtons() {
            const currentSlot = secondSlotControllers[secondIndex];
            const loadedCount = secondCountLoaded();
            
            // Check if we can go to previous scene
            const canGoPrev = secondIndex > 0;
            prevB.disabled = !canGoPrev;
            prevB.style.opacity = canGoPrev ? '1' : '0.5';
            
            // Check if we can go to next scene
            let canGoNext = false;
            if (currentSlot && currentSlot.isComposite) {
                const allPartsVisible = currentSlot.areAllPartsVisible ? currentSlot.areAllPartsVisible() : true;
                canGoNext = allPartsVisible && secondIndex < loadedCount - 1;
            } else {
                canGoNext = secondIndex < loadedCount - 1;
            }
            
            nextB.disabled = !canGoNext;
            nextB.style.opacity = canGoNext ? '1' : '0.5';
        }

        // Function to update navigation button states
        function updateNavigationButtons() {
            const currentSlot = slotControllers[index];
            const loadedCount = countLoaded();
            
            // Check if we can go to previous scene
            const canGoPrev = index > 0;
            prevB.disabled = !canGoPrev;
            prevB.style.opacity = canGoPrev ? '1' : '0.5';
            
            // Check if we can go to next scene
            let canGoNext = false;
            if (currentSlot && currentSlot.isComposite) {
                // For composite slots, check if all parts are visible
                const allPartsVisible = currentSlot.areAllPartsVisible ? currentSlot.areAllPartsVisible() : true;
                // Can go next if parts visible AND (not at scene 3 OR all scenes completed to unlock scene 4)
                canGoNext = allPartsVisible && index < loadedCount - 1;
                if (index === 2 && !allScenesCompleted) {
                    canGoNext = false; // Block navigation from scene 3 to 4 until completed
                }
            } else {
                // For regular slots, just check if there's a next scene
                canGoNext = index < loadedCount - 1;
                if (index === 2 && !allScenesCompleted) {
                    canGoNext = false; // Block navigation from scene 3 to 4 until completed
                }
            }
            
            nextB.disabled = !canGoNext;
            nextB.style.opacity = canGoNext ? '1' : '0.5';
        }

        // Show HUD only while target is tracked
        anchor.onTargetFound = () => { 
            hud.hidden = false; 
            targetFound = true;
            
            console.log(`Target found! Current slot: ${index}, slotControllers[${index}]:`, slotControllers[index]);
            
            // Trigger composite sequence if we're on a composite slot and it hasn't started yet
            if (slotControllers[index] && slotControllers[index].isComposite && !slotControllers[index].started) {
                console.log(`Target found, starting composite sequence for slot ${index}...`);
                slotControllers[index].startSequenceIfReady();
            } else {
                console.log(`Target found but not starting composite sequence - slotControllers[${index}]:`, slotControllers[index] ? `isComposite: ${slotControllers[index].isComposite}, started: ${slotControllers[index].started}` : 'null');
            }
        };
        anchor.onTargetLost = () => { 
            hud.hidden = true; 
            targetFound = false;
        };
        
        // ============ SECOND TARGET HANDLERS ============
        // Initialize second anchor and its event handlers (called when scene 4 is reached)
        function initializeSecondAnchor() {
            if (secondAnchorInitialized) return; // Already initialized
            
            console.log('Creating second anchor for building tracking...');
            secondAnchor = mindarThree.addAnchor(1); // Create second target anchor
            secondAnchorInitialized = true;
            
            // Set up event handlers for second target
            setupSecondTargetHandlers();
            
            // Load second target scenes
            loadSecondTargetScenes();
        }
        
        // Set up event handlers for second target
        function setupSecondTargetHandlers() {
            secondAnchor.onTargetFound = () => {
                if (allScenesCompleted) {
                    console.log('🎯 Second target (building) found! Showing building scenes...');
                    
                    secondTargetActive = true;
                    secondTargetFound = true;
                    // Show HUD for navigation
                    hud.hidden = false;
                    secondUpdateLabel();
                    secondUpdateNavigationButtons();
                    
                    // Trigger composite sequence if on composite slot
                    if (secondSlotControllers[secondIndex] && secondSlotControllers[secondIndex].isComposite && !secondSlotControllers[secondIndex].started) {
                        secondSlotControllers[secondIndex].startSequenceIfReady();
                    }
                    
                    showSecondTargetContent();
                } else {
                    console.log('Second target found but scenes not completed yet.');
                    showNotReadyMessage();
                }
            };
            
            secondAnchor.onTargetLost = () => {
                if (secondTargetActive) {
                    console.log('Second target lost.');
                    secondTargetActive = false;
                    secondTargetFound = false;
                    hud.hidden = true;
                    hideSecondTargetContent();
                }
            };
        }
        
        // Load all second target scenes (called when second anchor is initialized)
        function loadSecondTargetScenes() {
            console.log('Loading second target scenes...');
            
            // Second Target Scene 1 - Example composite scene
            secondLoadComposite(0, [
                // Add your second target scene 1 models here
                // Example: "./applications-20230306/applications/assets/bonus/scene1-part1.gltf",
                // Example: "./applications-20230306/applications/assets/bonus/scene1-part2.gltf",
            ], [0, 2000], [0, 0]);
            
            // Second Target Scene 2 - Example composite scene
            secondLoadComposite(1, [
                // Add your second target scene 2 models here
                // Example: "./applications-20230306/applications/assets/bonus/scene2-part1.gltf",
            ], [0], [0]);
            
            // Second Target Scene 3 - Example composite scene
            secondLoadComposite(2, [
                // Add your second target scene 3 models here
                // Example: "./applications-20230306/applications/assets/bonus/scene3-part1.gltf",
            ], [0], [0]);
        }
        
        // Show content for second target
        function showSecondTargetContent() {
            console.log('Displaying second target composite scenes...');
            // Show the current scene on second target
            secondApplyVisibility();
        }
        
        // Hide second target content
        function hideSecondTargetContent() {
            console.log('Hiding second target content...');
            // Hide all second target models
            secondModels.forEach(m => { if (m) m.visible = false; });
        }
        
        
        // Show message when second target found but not ready
        function showNotReadyMessage() {
            const message = document.createElement('div');
            message.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(255, 165, 0, 0.9);
                color: white;
                padding: 15px;
                border-radius: 8px;
                font-family: system-ui;
                font-size: 16px;
                text-align: center;
                z-index: 10000;
            `;
            message.innerHTML = `
                <p>⚠️ Complete all 3 scenes first!</p>
                <p>Then return to this target.</p>
            `;
            document.body.appendChild(message);
            
            setTimeout(() => {
                if (message.parentNode) {
                    message.parentNode.removeChild(message);
                }
            }, 3000);
        }

        // ============ LOAD OCCLUDER (always on) ============
        loader.load(
            "./applications-20230306/applications/assets/DataModel11_3/ghost.gltf",
            (gltf) => {
                const ghostScene = gltf.scene;
                ghostScene.position.set(0, 0, 0);
                ghostScene.rotation.set(0,0,0);

                prepOccluder(ghostScene);        // make it "ghost"
                anchor.group.add(ghostScene);    // DO NOT register; independent of arrows
                ghostScene.visible = true;
            },
            undefined,
            (err) => console.error("[GLTF] ghost load error:", err)
        );


        // ============ LOAD YOUR MODELS (per-model transforms) ============

        function register(obj, slot) {
            obj.visible = false;              // avoid a flash before we choose
            anchor.group.add(obj);            // attach to anchor
            models[slot] = obj;               // place into fixed slot
            applyVisibility();
        }
        
        // Register function for second target
        function secondRegister(obj, slot) {
            obj.visible = false;
            secondAnchor.group.add(obj);
            secondModels[slot] = obj;
            secondApplyVisibility();
        }




        // composite slot — multiple GLTFs in one scene, with sequential reveals
        // files: array of file paths (order = reveal order)
        // timing: array of absolute times in milliseconds (when each part should appear, first part at 0)
        // hideAfter: array of durations in milliseconds (how long each part stays visible, 0 = stays forever)
        function loadComposite(
            slot,
            files,
            timing, // array of absolute times in ms, e.g. [0, 2000, 5000] means: part0 at 0ms, part1 at 2000ms, part2 at 5000ms
            hideAfter, // array of durations in ms, e.g. [3000, 0, 0] means: part0 hides after 3s, part1&2 stay forever
            { resetOnLeave=true, exclusive=false, resetOnEnter=true } = {}
        ) {
            const group = new THREE.Group();
            group.name = `composite-slot-${slot}`;
            register(group, slot);

            const parts = [];            // roots per part (in reveal order)
            let timers = [];
            let allLoaded = 0;

            const clearTimers = () => { timers.forEach(id => clearTimeout(id)); timers = []; };


            function hidePart(i) {
                const p = parts[i];
                if (!p) return;
                
                console.log(`Hiding part ${i} after ${hideAfter[i]}ms`);
                p.visible = false;
                
                // Stop animations for this part
                stopAnimationsForPart(p);
                
                // Update navigation buttons after hiding part
                updateNavigationButtons();
            }

            function revealPart(i) {
                if (exclusive) parts.forEach((p, j) => { if (p) p.visible = (j === i); });

                const p = parts[i];
                if (!p) return;

                console.log(`Revealing part ${i}`);
                p.visible = true;

                // Start animations for this part
                startAnimationsForPart(p);

                // Update navigation buttons after revealing part
                updateNavigationButtons();

                // Set up auto-hide timer if specified
                if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                    const hideTimer = setTimeout(() => {
                        hidePart(i);
                    }, hideAfter[i]);
                    timers.push(hideTimer);
                    console.log(`Scheduled part ${i} to hide after ${hideAfter[i]}ms`);
                }
            }

            function startSequence() {
                if (slotControllers[slot].started) return;  // already started
                if (allLoaded < files.length) {
                    console.log(`Cannot start sequence: ${files.length - allLoaded} parts still loading`);
                    return;  // wait for all loaded
                }
                
                console.log(`Starting composite sequence with ${files.length} parts`);
                slotControllers[slot].started = true;
                clearTimers();
                
                // Normalize timing so that time zero is when the FIRST part appears
                const firstTime = (Array.isArray(timing) && timing.length > 0) ? (timing[0] || 0) : 0;
                files.forEach((_, i) => {
                    const absoluteTime = timing[i] || 0;
                    const relativeTime = Math.max(0, absoluteTime - firstTime);
                    const id = setTimeout(() => {
                        console.log(`Revealing part ${i} at ${relativeTime}ms (relative to first part at ${firstTime}ms)`);
                        revealPart(i);
                    }, relativeTime);
                    timers.push(id);
                });
            }

            function hideAllParts() {
                parts.forEach(p => { 
                    if (p) {
                        p.visible = false;
                        stopAnimationsForPart(p);
                    }
                });
            }

            // Animation handling functions
            function startAnimationsForPart(part) {
                const target = part; // play clips on the root part
                const clips = (target.userData && Array.isArray(target.userData.clips)) ? target.userData.clips : [];
                if (!clips.length) return;

                const mixer = new THREE.AnimationMixer(target);
                target.userData.mixers = target.userData.mixers || [];
                target.userData.mixers.push(mixer);

                clips.forEach((clip) => {
                    const action = mixer.clipAction(clip);
                    action.reset();
                    action.setLoop(THREE.LoopOnce);
                    action.clampWhenFinished = true;
                    action.time = 0;
                    action.enabled = true;
                    action.setEffectiveWeight(1.0);
                    action.fadeIn(0);
                    action.play();
                    console.log(`Started animation: ${clip.name} on composite part root (play once)`);
                });
            }

            function stopAnimationsForPart(part) {
                part.traverse((child) => {
                    if (child.userData.mixers) {
                        child.userData.mixers.forEach(mixer => mixer.stopAllAction());
                        child.userData.mixers = [];
                    }
                });
            }

            // controller hooks for this slot
            slotControllers[slot] = {
                isComposite: true, // Flag to identify this as a composite slot
                started: false, // Track if sequence has started
                
                onEnter() {
                    console.log(`Composite slot ${slot} entered, targetFound: ${targetFound}, allLoaded: ${allLoaded}/${files.length}`);
                    if (resetOnEnter) {
                        clearTimers();
                        hideAllParts();
                        this.started = false;
                    }
                    
                    // Check if target is already found and start sequence immediately
                    if (targetFound && allLoaded >= files.length) {
                        console.log(`Composite slot ${slot} entered with target already found, starting sequence immediately...`);
                        startSequence();
                        this.started = true;
                    } else {
                        console.log(`Composite slot ${slot} entered, waiting for target recognition...`);
                    }
                },
                onLeave() {
                    clearTimers();
                    if (resetOnLeave) { hideAllParts(); }
                    this.started = false;
                },
                startSequenceIfReady() {
                    // Only start if target is found and we haven't started yet
                    if (targetFound && !this.started) {
                        console.log(`Starting composite sequence for slot ${slot} (target found, all ready)`);
                        if (allLoaded >= files.length) {
                            startSequence();
                            this.started = true;
                        } else {
                            console.log(`Waiting for ${files.length - allLoaded} more parts to load...`);
                        }
                    }
                },
                areAllPartsVisible() {
                    // Check if all parts that should STAY visible (hideAfter = 0) are actually visible
                    // Parts with hideAfter > 0 are temporary, so we ignore them for navigation
                    return parts.every((part, i) => {
                        if (!part) return true; // If part doesn't exist, consider it "visible"
                        // If this part has auto-hide (hideAfter > 0), don't check its visibility
                        if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                            return true; // Temporary parts don't block navigation
                        }
                        return part.visible; // Permanent parts must be visible
                    });
                }
            };

            // load each file; start sequence when all loaded
            files.forEach((path, i) => {
                console.log(`Loading composite part ${i}: ${path}`);
                loader.load(path, (gltf) => {
                    console.log(`Loaded part ${i}: ${path}`);
                    const root = gltf.scene;
                    root.visible = false;
                    root.position.set(0,0,0);
                    root.rotation.set(0,0,0);
                    // Attach animations from the GLTF to the root so we can play them later
                    root.userData = root.userData || {};
                    root.userData.clips = Array.isArray(gltf.animations) ? gltf.animations : [];
                    prepContent(root);     // draw after occluders
                    group.add(root);
                    parts[i] = root;

                    allLoaded++;
                    console.log(`Part ${i} loaded. Total loaded: ${allLoaded}/${files.length}`);
                    // Check if we should start sequence (target found and all loaded)
                    if (models[slot] === group && index === slot && targetFound) {
                        slotControllers[slot].startSequenceIfReady();
                    }
                });
            });
        }

        // ============ LOAD COMPOSITE FOR SECOND TARGET ============
        // Similar to loadComposite but for second target scenes
        function secondLoadComposite(slot, files, timing, hideAfter, { resetOnLeave=true, exclusive=false, resetOnEnter=true } = {}) {
            const group = new THREE.Group();
            group.name = `second-composite-slot-${slot}`;
            secondRegister(group, slot);

            const parts = [];
            let timers = [];
            let allLoaded = 0;

            const clearTimers = () => { timers.forEach(id => clearTimeout(id)); timers = []; };

            function hidePart(i) {
                const p = parts[i];
                if (!p) return;
                console.log(`[Second Target] Hiding part ${i}`);
                p.visible = false;
                stopAnimationsForPart(p);
            }

            function revealPart(i) {
                if (exclusive) {
                    parts.forEach((p, j) => {
                        if (p) {
                            p.visible = (j === i);
                            if (j !== i) stopAnimationsForPart(p);
                        }
                    });
                }

                const p = parts[i];
                if (!p) return;
                console.log(`[Second Target] Revealing part ${i}`);
                p.visible = true;
                startAnimationsForPart(p);

                if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                    const hideTimer = setTimeout(() => {
                        hidePart(i);
                    }, hideAfter[i]);
                    timers.push(hideTimer);
                }
            }

            function startAnimationsForPart(part) {
                const target = part;
                const clips = (target.userData && Array.isArray(target.userData.clips)) ? target.userData.clips : [];
                if (!clips.length) return;

                const mixer = new THREE.AnimationMixer(target);
                target.userData.mixers = target.userData.mixers || [];
                target.userData.mixers.push(mixer);

                clips.forEach((clip) => {
                    const action = mixer.clipAction(clip);
                    action.reset();
                    action.setLoop(THREE.LoopOnce);
                    action.clampWhenFinished = true;
                    action.time = 0;
                    action.enabled = true;
                    action.setEffectiveWeight(1.0);
                    action.fadeIn(0);
                    action.play();
                });
            }

            function stopAnimationsForPart(part) {
                part.traverse((child) => {
                    if (child.userData.mixers) {
                        child.userData.mixers.forEach(mixer => mixer.stopAllAction());
                        child.userData.mixers = [];
                    }
                });
            }

            function startSequence() {
                if (secondSlotControllers[slot].started) return;
                if (allLoaded < files.length) return;
                
                secondSlotControllers[slot].started = true;
                clearTimers();
                
                let cumulativeTime = 0;
                files.forEach((_, i) => {
                    cumulativeTime += timing[i] || 0;
                    const id = setTimeout(() => {
                        revealPart(i);
                    }, cumulativeTime);
                    timers.push(id);
                });
            }

            function hideAllParts() {
                parts.forEach(p => {
                    if (p) {
                        p.visible = false;
                        stopAnimationsForPart(p);
                    }
                });
            }

            secondSlotControllers[slot] = {
                isComposite: true,
                started: false,
                
                onEnter() {
                    if (resetOnEnter) {
                        clearTimers();
                        hideAllParts();
                        this.started = false;
                    }
                    
                    if (secondTargetFound && allLoaded >= files.length) {
                        startSequence();
                        this.started = true;
                    }
                },
                onLeave() {
                    clearTimers();
                    if (resetOnLeave) { hideAllParts(); }
                    this.started = false;
                },
                startSequenceIfReady() {
                    if (secondTargetFound && !this.started) {
                        if (allLoaded >= files.length) {
                            startSequence();
                            this.started = true;
                        }
                    }
                },
                areAllPartsVisible() {
                    return parts.every((part, i) => {
                        if (!part) return true;
                        return part.visible;
                    });
                }
            };

            files.forEach((path, i) => {
                console.log(`[Second Target] Loading composite part ${i}: ${path}`);
                loader.load(path, (gltf) => {
                    console.log(`[Second Target] Loaded part ${i}: ${path}`);
                    const root = gltf.scene;
                    root.visible = false;
                    root.position.set(0,0,0);
                    root.rotation.set(0,0,0);
                    root.userData = root.userData || {};
                    root.userData.clips = Array.isArray(gltf.animations) ? gltf.animations : [];
                    prepContent(root);
                    group.add(root);
                    parts[i] = root;

                    allLoaded++;
                    console.log(`[Second Target] Part ${i} loaded. Total loaded: ${allLoaded}/${files.length}`);
                    if (secondModels[slot] === group && secondIndex === slot && secondTargetFound) {
                        secondSlotControllers[slot].startSequenceIfReady();
                    }
                });
            });
        }

        // --- Slots (TOTAL = 3) ---
        

        // Slot 1: COMPOSITE of three files, revealed 3s apart (accumulating)

        // ============ LOAD SCENES ============
        // Scene 1: Single model


        loadComposite(0, [

            "./applications-20230306/applications/assets/DataModel11_3/Sahne1/Sahne1Mevcut.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1/Sahne1Mevcutisik.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1/Sahne1Cerceve.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1/Sahne1Gridisik.gltf",

        ],  [0, 2000, 4000, 6000], 
            [0, 0, 0, 0], {

            exclusive: false,
            resetOnLeave: true,
            resetOnEnter: true
        });

        loadComposite(1, [
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2/Sahne2Mevcut.gltf",   
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2/Sahne2Kapanacak.gltf",    
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2/Sahne2Acilicak.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2/Sahne2Acilicakisik.gltf",    
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2/Sahne2Cerceve.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2/Sahne2Gridisik.gltf",          
        ], 

        [   0, 2000, 4000, 6000, 8000, 10000], 
        
        // HideAfter array - how long each part stays (0 = forever)
        [ 0, 0, 0, 0, 0, 0], {

            exclusive: false,
            resetOnLeave: true,
            resetOnEnter: true
        });

        loadComposite(2, [
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3/Sahne3Mevcut.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3/Sahne3Kapanacak.gltf",    
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3/Sahne3Acilicak.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3/Sahne3isik.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3/Sahne3cerceve.gltf",

              
        ], [0, 0, 0, 0, 0,],

            [0, 0, 0, 0, 0, 0], {

            exclusive: false,
            resetOnLeave: true,
            resetOnEnter: true
        });


        // ============ SCENE 4: GUIDE TO SECOND TARGET ============
        // Load 4th scene with line drawing guide (appears after viewing first 3 scenes)
        function loadGuideScene() {
            const group = new THREE.Group();
            group.name = 'guide-scene';
            
            // Create a plane for the line drawing image
            const textureLoader = new THREE.TextureLoader();
            textureLoader.load(
                './applications-20230306/applications/assets/targets/building-line.png',
                (texture) => {
                    // Create plane geometry with appropriate aspect ratio
                    const aspectRatio = texture.image.width / texture.image.height;
                    const planeWidth = 0.3;
                    const planeHeight = planeWidth / aspectRatio;
                    
                    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
                    const material = new THREE.MeshBasicMaterial({
                        map: texture,
                        transparent: true,
                        side: THREE.DoubleSide
                    });
                    
                    const linePlane = new THREE.Mesh(geometry, material);
                    linePlane.position.set(0, 0.05, 0); // Slightly above the target
                    group.add(linePlane);
                    
                    // Add instruction text using CSS3DRenderer or create 3D text
                    // For now, we'll create a simple text sprite
                    createTextSprite('Turn to your left\nto match this line', group);
                    
                    register(group, 3); // Register as scene 4 (index 3)
                },
                undefined,
                (err) => console.error('Error loading guide image:', err)
            );
        }
        
        // Create text sprite for AR instructions
        function createTextSprite(text, parentGroup) {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = 512;
            canvas.height = 256;
            
            // Draw text
            context.fillStyle = 'rgba(0, 0, 0, 0.8)';
            context.fillRect(0, 0, canvas.width, canvas.height);
            
            context.font = 'bold 40px Arial';
            context.fillStyle = 'white';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            
            // Split text by newlines and draw each line
            const lines = text.split('\n');
            const lineHeight = 50;
            const startY = (canvas.height - (lines.length - 1) * lineHeight) / 2;
            
            lines.forEach((line, i) => {
                context.fillText(line, canvas.width / 2, startY + i * lineHeight);
            });
            
            // Create texture from canvas
            const texture = new THREE.CanvasTexture(canvas);
            const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
            const sprite = new THREE.Sprite(material);
            
            sprite.scale.set(0.25, 0.125, 1);
            sprite.position.set(0, -0.15, 0); // Below the line drawing
            
            parentGroup.add(sprite);
        }
        
        // Load the guide scene (4th scene on first target)
        loadGuideScene();
        
        // NOTE: Second target scenes are loaded lazily when scene 4 is reached
        // This optimizes performance by not tracking the second target until needed

        // ============ START ============
        // ============ START AR ============
        await mindarThree.start();
        
        // Animation mixer for updating animations
        const clock = new THREE.Clock();
        
        renderer.setAnimationLoop(() => {
            const delta = Math.min(clock.getDelta(), 0.1); // Cap delta to prevent large jumps
            
            // Update all animation mixers for first target
            models.forEach(model => {
                if (model && model.visible) { // Only update visible models
                    model.traverse((child) => {
                        if (child.userData.mixers) {
                            child.userData.mixers.forEach(mixer => {
                                mixer.update(delta);
                            });
                        }
                    });
                }
            });
            
            // Update all animation mixers for second target
            secondModels.forEach(model => {
                if (model && model.visible) { // Only update visible models
                    model.traverse((child) => {
                        if (child.userData.mixers) {
                            child.userData.mixers.forEach(mixer => {
                                mixer.update(delta);
                            });
                        }
                    });
                }
            });
            
            renderer.render(scene, camera);
        });

        // Debug helper - expose to global scope for testing
        window.debugAR = {
            testCompositeSlots: () => {
                console.log('Testing composite slots...');
                if (slotControllers[1]) {
                    console.log('Triggering composite slot onEnter...');
                    slotControllers[1].onEnter();
                }
            },
            getSlotState: () => {
                console.log('Current slot state:');
                console.log('Active slot:', index);
                console.log('Slot controllers:', slotControllers.map((c, i) => ({ slot: i, hasController: !!c })));
            }
        };

        // ---------- helpers ----------
        function createHUD() {
            const hud = document.createElement('div');
            hud.className = 'hud';
            hud.id = 'hud';
            hud.hidden = true;
            hud.innerHTML = `
                <button id="prev" class="arrow" aria-label="Previous">◀</button>
                <div class="label" id="label">0/0</div>
                <button id="next" class="arrow" aria-label="Next">▶</button>
            `;
            document.body.appendChild(hud);
            return {
                hud,
                prevB: hud.querySelector('#prev'),
                nextB: hud.querySelector('#next'),
                label: hud.querySelector('#label')
            };
        }

        function injectHUDStyles() {
            const css = `
                #ar-container { position: fixed; inset: 0; background: #000; }
                .hud {
                position: fixed;
                left: 0; right: 0;
                bottom: max(env(safe-area-inset-bottom), 16px);
                display: flex; gap: 12px; justify-content: center; align-items: center;
                pointer-events: none; /* let taps pass EXCEPT on buttons */
                font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
                z-index: 9999;
                }
                .hud .arrow {
                pointer-events: auto;
                border: 0; border-radius: 999px; padding: 12px 16px;
                font-size: 18px; background: rgba(255,255,255,.92);
                box-shadow: 0 6px 18px rgba(0,0,0,.25);
                transition: opacity 0.3s ease;
                }
                .hud .arrow:disabled {
                pointer-events: none;
                cursor: not-allowed;
                }
                .hud .arrow:disabled:hover {
                transform: none;
                }
                .hud .label {
                pointer-events: none; color: #fff; font-weight: 700;
                text-shadow: 0 2px 8px rgba(0,0,0,.6);
                }
                canvas { touch-action: none; } /* improves mobile pointer behavior */
            `;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }        
    }
    start();
});