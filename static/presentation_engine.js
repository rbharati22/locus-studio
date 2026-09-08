let currentDeck = null;
let currentSlideIndex = 0;
let currentRevealStep = 1;
let maxStepsOnSlide = 0;
let isIntroActive = true; 
let resizeObserver = null; 

function loadDeck(deck) {
    currentDeck = deck;
    currentSlideIndex = 0;
    currentRevealStep = 1;
    isIntroActive = true;
    
    if (typeof buildSidebarNav === "function") {
        buildSidebarNav();
    }
    
    if (typeof updateSidebar === "function") {
        isIntroActive = false; 
        document.body.classList.add('scaffolding-active');
        const intro = document.getElementById('cinematicIntro');
        if(intro) intro.style.display = 'none';
        updateSidebar();
        renderSlide();
    }
}

function dismissIntro() {
    isIntroActive = false;
    const intro = document.getElementById('cinematicIntro');
    if (intro) {
        intro.classList.remove('show-text');
        intro.classList.add('hidden');
    }
    document.body.classList.add('scaffolding-active');
    renderSlide();
}

function renderSlide() {
    const container = document.getElementById('slideContainer');
    if (!container) return;
    if (!currentDeck || !currentDeck.slides || currentDeck.slides.length === 0) return;
    
    const slide = currentDeck.slides[currentSlideIndex];
    
    // CRITICAL FIX 1: Prevent iframe reloading & flashing by persisting it in the DOM across slides
    let prevMediaSrc = null;
    if (window.cachedSlideIndex !== undefined && currentDeck.slides[window.cachedSlideIndex]) {
        prevMediaSrc = currentDeck.slides[window.cachedSlideIndex].media_panel?.src;
    }
    const currentMediaSrc = slide.media_panel?.src;

    // Only destroy the media panel if the source file actually changed
    if (prevMediaSrc !== currentMediaSrc) {
        if (window.cachedMediaPanel) {
            window.cachedMediaPanel.remove();
            window.cachedToggleBtn.remove();
            window.cachedMediaStrip.remove();
        }
        window.cachedMediaPanel = null;
        window.cachedToggleBtn = null;
        window.cachedMediaStrip = null;
        window.cachedUiState = 0;
    }
    window.cachedSlideIndex = currentSlideIndex;

    container.className = `slide-container layout-${slide.layout || 'split_left_theory'}`;
    
    if (resizeObserver) resizeObserver.disconnect();
    
    maxStepsOnSlide = Math.max(...slide.theory_fragments.map(f => f.reveal_step || 1), 1);
    
    let lastWipeStep = -1;
    slide.theory_fragments.forEach(f => {
        if (f.reveal_step <= currentRevealStep && f.clear_screen) {
            lastWipeStep = Math.max(lastWipeStep, f.reveal_step);
        }
    });

    // CRITICAL FIX: Reuse the theory panel if it exists so the DOM sibling order NEVER changes. 
    // Moving DOM nodes next to an active iframe causes WebKit/Blink to forcefully reload it.
    let theoryPanel = container.querySelector('.slide-panel');
    let innerCanvas = null;

    if (!theoryPanel) {
        theoryPanel = document.createElement('div');
        theoryPanel.className = "slide-panel";
        innerCanvas = document.createElement('div');
        innerCanvas.className = "theory-inner-canvas";
        theoryPanel.appendChild(innerCanvas);
        container.insertBefore(theoryPanel, container.firstChild);
    } else {
        innerCanvas = theoryPanel.querySelector('.theory-inner-canvas');
        innerCanvas.innerHTML = ""; // Just wipe the text, keep the structural DOM intact
    }
    
    if (lastWipeStep === -1) {
        const titleEl = document.createElement('h2');
        titleEl.innerText = slide.title || "";
        titleEl.style.fontSize = "36px";
        titleEl.style.marginBottom = "20px";
        innerCanvas.appendChild(titleEl);
    }

    slide.theory_fragments.forEach(frag => {
        if (frag.reveal_step < lastWipeStep) return;

        // CRITICAL FIX 2: Generate ALL future fragments in the DOM so they can be smoothly revealed later
        let el = document.createElement('div');
        el.className = `fragment ${frag.type === 'math' ? 'math-block' : (frag.type === 'code' ? 'code-block' : 'text-block')}`;
        el.setAttribute('data-step', frag.reveal_step);
        el.setAttribute('data-clear-screen', frag.clear_screen ? 'true' : 'false');
        
        if (frag.type === 'math') {
            katex.render(frag.content, el, { displayMode: true, throwOnError: false });
        } else if (frag.type === 'code') {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.innerText = frag.content; 
            pre.appendChild(code);
            el.appendChild(pre);
        } else {
            let formattedText = frag.content.replace(/\$([\s\S]*?)\$/g, (match, math) => {
                try { return katex.renderToString(math, { throwOnError: false }); } 
                catch (e) { return match; }
            });
            
            // Add Markdown Support for the AI's text fragments
            formattedText = formattedText.replace(/\*\*([^\*]+)\*\*/g, '<strong style="color: #00E5FF;">$1</strong>'); // Bold (Cyan accent)
            formattedText = formattedText.replace(/\*([^\*]+)\*/g, '<em>$1</em>'); // Italics
            formattedText = formattedText.replace(/\n/g, '<br>'); // Preserve newlines
            
            el.innerHTML = formattedText; 
        }

        if (frag.reveal_step < currentRevealStep) {
            el.classList.add('visible', 'no-anim'); 
        } else if (frag.reveal_step === currentRevealStep) {
            setTimeout(() => {
                el.classList.add('visible');
                // Use 'nearest' to prevent the entire page body from jumping and vibrating
                el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 50);
        }
        
        innerCanvas.appendChild(el);
    });

    function applyGeometricScale(availableWidth) {
        if (availableWidth === 0) return;
        const padding = 40; 
        const safeWidth = availableWidth - padding;
        const children = innerCanvas.children;
        for (let i = 0; i < children.length; i++) {
            let el = children[i];
            let elWidth = el.offsetWidth;
            if (elWidth > safeWidth && safeWidth > 0) {
                el.style.scale = safeWidth / elWidth;
            } else {
                el.style.scale = 1;
            }
        }
    }

    resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            applyGeometricScale(entry.contentRect.width);
        }
    });
    resizeObserver.observe(theoryPanel);

    const currentFrag = slide.theory_fragments.find(f => f.reveal_step === currentRevealStep);
    let targetSyncTime = null;
    if (currentFrag && currentFrag.video_sync_time !== undefined && currentFrag.video_sync_time !== null) {
        targetSyncTime = parseFloat(currentFrag.video_sync_time);
    }

    let mediaItems = [];
    if (slide.media_panel && slide.media_panel.media_type !== "none") {
        mediaItems.push(slide.media_panel); 
    }

    if (mediaItems.length > 0) {
        if (!window.cachedMediaPanel) {
            window.cachedUiState = 0; 
            
            const toggleBtn = document.createElement('button');
            toggleBtn.className = "drawer-toggle-btn";
            
            // Initial closed state based on layout side
            if (slide.layout === 'split_right_theory') {
                toggleBtn.innerHTML = "▶";
                toggleBtn.style.left = "0";
                toggleBtn.style.right = "auto";
            } else {
                toggleBtn.innerHTML = "◀";
                toggleBtn.style.right = "0";
                toggleBtn.style.left = "auto";
            }
            
            const mediaStrip = document.createElement('div');
            mediaStrip.className = "media-strip";
            
            const previewPanel = document.createElement('div');
            previewPanel.className = "media-preview-panel";

            const resizer = document.createElement('div');
            resizer.className = "drawer-resizer";
            previewPanel.appendChild(resizer);

            loadMediaPreview(mediaItems[0], previewPanel, targetSyncTime);

            toggleBtn.onclick = (e) => {
                e.stopPropagation(); 
                
                // --- FULL WIDTH MEDIA INTERCEPT ---
                if (slide.layout === 'full_media') {
                    // 1. Lock current 100% width in pixels so the transition has a starting point
                    let startWidth = previewPanel.getBoundingClientRect().width;
                    previewPanel.style.width = `${startWidth}px`;
                    previewPanel.style.minWidth = `${startWidth}px`;
                    
                    // 2. Change layout to Media Left / Theory Right
                    slide.layout = 'split_right_theory';
                    container.className = 'slide-container layout-split_right_theory';
                    
                    // 3. FORCE BROWSER REFLOW: This tells the CSS engine to register the new class and starting pixels
                    void previewPanel.offsetWidth;
                    
                    // 4. Calculate the target split width
                    let splitRatio = parseFloat(slide.partition);
                    if (isNaN(splitRatio) || splitRatio >= 0.9) splitRatio = 0.5; 
                    let targetPreviewWidth = (container.getBoundingClientRect().width - 100) * (1 - splitRatio);
                    
                    // 5. Update the CSS styles for relative flexbox positioning
                    previewPanel.style.position = 'relative';
                    previewPanel.style.height = 'calc(100% - 4cm)';
                    previewPanel.style.margin = '2cm 0';
                    
                    // 6. ANIMATE: Execute the shrink animation on the very next browser frame
                    requestAnimationFrame(() => {
                        previewPanel.style.width = `${targetPreviewWidth}px`;
                        previewPanel.style.minWidth = `${targetPreviewWidth}px`; 
                        
                        // Snap button to the inner seam and update icon
                        toggleBtn.innerHTML = "◀";
                        toggleBtn.style.left = `${targetPreviewWidth + 50}px`;
                        toggleBtn.style.right = "auto";
                    });
                    
                    // 7. Sync the JS memory state to 'open' so subsequent clicks collapse it naturally
                    window.cachedUiState = 2;
                    
                    return; // Stop standard toggle execution
                }

                if (window.cachedUiState === 0) {
                    window.cachedUiState = 2; 
                    
                    let targetPreviewWidth;
                    if ((slide.layout === 'overlay_glass' || slide.layout === 'full_media')) {
                        targetPreviewWidth = container.getBoundingClientRect().width;
                        previewPanel.style.position = 'absolute';
                        previewPanel.style.top = '0';
                        previewPanel.style.left = '0';
                        previewPanel.style.height = '100%';
                        previewPanel.style.margin = '0';
                        previewPanel.style.zIndex = '1';
                    } else {
                        let splitRatio = parseFloat(slide.partition);
                        if (isNaN(splitRatio) || splitRatio >= 0.9) splitRatio = 0.5; 
                        targetPreviewWidth = (container.getBoundingClientRect().width - 100) * (1 - splitRatio);
                    }
                    
                    previewPanel.classList.add('open');
                    previewPanel.style.width = `${targetPreviewWidth}px`;
                    previewPanel.style.minWidth = `${targetPreviewWidth}px`; 
                    
                    // Attach button to the correct active edge
                    if (slide.layout === 'split_right_theory') {
                        toggleBtn.innerHTML = "◀";
                        toggleBtn.style.left = `${targetPreviewWidth + 50}px`;
                        toggleBtn.style.right = "auto";
                    } else {
                        toggleBtn.innerHTML = "▶";
                        toggleBtn.style.right = (slide.layout === 'overlay_glass' || slide.layout === 'full_media') ? '0px' : `${targetPreviewWidth + 50}px`;
                        toggleBtn.style.left = "auto";
                    }
                } else {
                    window.cachedUiState = 0; 
                    mediaStrip.classList.remove('open');
                    previewPanel.classList.remove('open');
                    previewPanel.style.width = "0px";
                    previewPanel.style.minWidth = "0px";
                    
                    // Revert button to closed edge
                    if (slide.layout === 'split_right_theory') {
                        toggleBtn.innerHTML = "▶";
                        toggleBtn.style.left = "0";
                        toggleBtn.style.right = "auto";
                    } else {
                        toggleBtn.innerHTML = "◀";
                        toggleBtn.style.right = "0";
                        toggleBtn.style.left = "auto";
                    }
                    
                    const activeMedia = previewPanel.querySelector('.media-embed');
                    if (activeMedia) {
                        if (activeMedia.tagName === 'VIDEO') {
                            activeMedia.pause();
                        } else if (activeMedia.tagName === 'IFRAME' && activeMedia.src.includes('youtube.com')) {
                            activeMedia.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
                        }
                    }
                }
            };

            resizer.addEventListener('pointerdown', (e) => {
                if (window.cachedUiState !== 2) return;
                e.stopPropagation();
                window.__isResizing = true;
                document.body.style.cursor = 'col-resize';
                previewPanel.style.transition = 'none';
            });

            window.cachedMediaPanel = previewPanel;
            window.cachedToggleBtn = toggleBtn;
            window.cachedMediaStrip = mediaStrip;
            
            container.appendChild(window.cachedMediaPanel);
            container.appendChild(window.cachedMediaStrip);
            container.appendChild(window.cachedToggleBtn);
        }

        if (!window.__resizerBound) {
            window.__resizerBound = true;
            document.addEventListener('pointermove', (e) => {
                const activePanel = document.querySelector('.media-preview-panel.open');
                if (!window.__isResizing || !activePanel) return;
                
                const containerRect = document.getElementById('slideContainer').getBoundingClientRect();
                const currentLayout = currentDeck.slides[currentSlideIndex].layout;
                let newWidth;
                
                // Calculate drag distance from the correct side of the screen
                if (currentLayout === 'split_right_theory') {
                    newWidth = e.clientX - containerRect.left - 50;
                } else {
                    newWidth = containerRect.right - e.clientX - 50;
                }
                
                if (newWidth < 300) newWidth = 300;
                if (newWidth > containerRect.width * 0.8) newWidth = containerRect.width * 0.8;
                
                activePanel.style.width = `${newWidth}px`;
                activePanel.style.minWidth = `${newWidth}px`; 
                
                // Keep button attached to the active dragging edge
                const toggleBtn = document.querySelector('.drawer-toggle-btn');
                if (currentLayout === 'split_right_theory') {
                    toggleBtn.style.left = `${newWidth + 50}px`;
                    toggleBtn.style.right = "auto";
                } else {
                    toggleBtn.style.right = `${newWidth + 50}px`;
                    toggleBtn.style.left = "auto";
                }
            });

            document.addEventListener('pointerup', () => {
                if (window.__isResizing) {
                    window.__isResizing = false;
                    document.body.style.cursor = 'default';
                    const activePanel = document.querySelector('.media-preview-panel.open');
                    if (activePanel) activePanel.style.transition = 'width 0.7s cubic-bezier(0.16, 1, 0.3, 1)';
                }
            });
        }

        // Layout Persistence (When AI swaps layouts between slides)
        if (window.cachedUiState === 2 && window.cachedMediaPanel) {
            let targetPreviewWidth;
            if ((slide.layout === 'overlay_glass' || slide.layout === 'full_media')) {
                targetPreviewWidth = container.getBoundingClientRect().width;
                window.cachedMediaPanel.style.position = 'absolute';
                window.cachedMediaPanel.style.top = '0';
                window.cachedMediaPanel.style.left = '0';
                window.cachedMediaPanel.style.height = '100%';
                window.cachedMediaPanel.style.margin = '0';
                window.cachedMediaPanel.style.zIndex = '1';
            } else {
                let splitRatio = parseFloat(slide.partition);
                if (isNaN(splitRatio) || splitRatio >= 0.9) splitRatio = 0.5; 
                targetPreviewWidth = (container.getBoundingClientRect().width - 100) * (1 - splitRatio);
                window.cachedMediaPanel.style.position = 'relative';
                window.cachedMediaPanel.style.height = 'calc(100% - 4cm)';
                window.cachedMediaPanel.style.margin = '2cm 0';
            }
            window.cachedMediaPanel.style.width = `${targetPreviewWidth}px`;
            window.cachedMediaPanel.style.minWidth = `${targetPreviewWidth}px`; 
            
            // Maintain button position across slides
            if (slide.layout === 'split_right_theory') {
                window.cachedToggleBtn.innerHTML = "◀";
                window.cachedToggleBtn.style.left = `${targetPreviewWidth + 50}px`;
                window.cachedToggleBtn.style.right = "auto";
            } else {
                window.cachedToggleBtn.innerHTML = "▶";
                window.cachedToggleBtn.style.right = (slide.layout === 'overlay_glass' || slide.layout === 'full_media') ? '0px' : `${targetPreviewWidth + 50}px`;
                window.cachedToggleBtn.style.left = "auto";
            }
        }

        if (targetSyncTime !== null && window.cachedUiState === 2) {
            const activeVid = window.cachedMediaPanel.querySelector('video');
            if (activeVid) {
                activeVid.currentTime = targetSyncTime;
                activeVid.play();
            } else {
                const activeYt = window.cachedMediaPanel.querySelector('iframe');
                if (activeYt && activeYt.src.includes('youtube.com')) {
                    activeYt.contentWindow.postMessage(JSON.stringify({"event": "command", "func": "seekTo", "args": [targetSyncTime, true]}), '*');
                    activeYt.contentWindow.postMessage(JSON.stringify({"event": "command", "func": "playVideo", "args": ""}), '*');
                }
            }
        }
    }
    buildSidebarNav();
}

function buildSidebarNav() {
    const list = document.getElementById('slideNavList');
    if (!list || !currentDeck) return;
    list.innerHTML = '';
    
    let lastValidTitle = "Untitled Topic";
    
    currentDeck.slides.forEach((slide, idx) => {
        let slideTitle = (slide.title && slide.title.trim() !== "") ? slide.title.trim() : null;
        
        if (slideTitle) {
            lastValidTitle = slideTitle;
        } else {
            slideTitle = lastValidTitle + " (cont.)";
        }

        const item = document.createElement('div');
        item.className = 'nav-item' + (idx === currentSlideIndex ? ' active' : '');
        item.innerText = `${idx + 1}. ${slideTitle}`;
        item.onclick = (e) => { 
            e.stopPropagation(); 
            document.getElementById('slideNavDrawer').classList.remove('open');
            jumpToSlide(idx); 
        };
        list.appendChild(item);
    });
}

function jumpToSlide(index) {
    if (index < 0 || index >= currentDeck.slides.length) return;
    currentSlideIndex = index;
    const targetSlide = currentDeck.slides[currentSlideIndex];
    currentRevealStep = Math.max(...targetSlide.theory_fragments.map(f => f.reveal_step || 1), 1);
    renderSlide();
    if (typeof clearSlideInk === "function") clearSlideInk();
}

function loadMediaPreview(media, container, initialSyncTime = null) {
    const resizer = container.querySelector('.drawer-resizer');
    container.innerHTML = ""; 
    if (resizer) container.appendChild(resizer);

    let el;
    let finalSrc = media.src || "";

    if (media.media_type === "video") {
        const ytMatch = finalSrc.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
        if (ytMatch) {
            el = document.createElement('iframe');
            let ytUrl = `https://www.youtube.com/embed/${ytMatch[1]}?enablejsapi=1&autoplay=${media.autoplay ? 1 : 0}`;
            if (initialSyncTime !== null) {
                ytUrl += `&start=${Math.floor(initialSyncTime)}&autoplay=1`;
            }
            el.src = ytUrl;
            el.allow = "autoplay; encrypted-media; fullscreen";
        } else {
            el = document.createElement('video');
            el.src = finalSrc;
            el.controls = media.controls !== false;
            if (initialSyncTime !== null) {
                el.currentTime = initialSyncTime;
                el.autoplay = true;
            } else {
                el.autoplay = media.autoplay === true;
            }
        }
    } else if (media.media_type === "pdf" || media.media_type === "drive_doc") {
        el = document.createElement('iframe');
        const driveMatch = finalSrc.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (driveMatch) finalSrc = `https://drive.google.com/file/d/${driveMatch[1]}/preview`;
        const docMatch = finalSrc.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
        if (docMatch) finalSrc = `https://docs.google.com/document/d/${docMatch[1]}/preview`;
        el.src = finalSrc;
        el.allow = "fullscreen";
    } else if (media.media_type === "image") {
        el = document.createElement('img');
        el.src = finalSrc;
    } else if (media.media_type === "web_widget") {
        el = document.createElement('iframe');
        
        // Match the filename in the text box with the code stored in the JSON
        let embeddedScript = null;
        if (currentDeck.media_scripts) {
            embeddedScript = currentDeck.media_scripts.find(s => 
                s.filename === finalSrc || 
                '/media/' + s.filename === finalSrc || 
                s.filename === finalSrc.replace('/media/', '')
            );
        }
        
        if (embeddedScript) {
            el.srcdoc = embeddedScript.code; // Extract directly from JSON memory!
        } else if (finalSrc.trim().startsWith("<")) {
            el.srcdoc = finalSrc; // Backwards compatibility for old decks
        } else {
            el.src = finalSrc; // Fallback to live URL if saved externally
        }
        
        el.style.backgroundColor = "transparent"; 
        el.allow = "fullscreen; autoplay; execution-while-not-rendered";
    } else if (media.media_type === "graph_2d") {
        el = document.createElement('div');
        el.style.color = "white"; 
        el.style.textAlign = "center"; 
        el.style.padding = "20px";
        el.innerText = `Graph formula:\n${media.graph_formula}`;
    }
    
    if (el) {
        el.className = "media-embed";
        el.style.overflow = "hidden"; 
        container.appendChild(el);

        if (media.media_type !== "graph_2d") {
            // 1. Create a transparent Swipe Shield at the top edge
            const swipeZone = document.createElement('div');
            swipeZone.style.position = "absolute";
            swipeZone.style.top = "0";
            swipeZone.style.left = "0";
            swipeZone.style.width = "100%";
            swipeZone.style.height = "60px"; // Top 60 pixels of the panel
            swipeZone.style.zIndex = "1000";
            swipeZone.style.touchAction = "none"; // CRITICAL: Stops the browser from hijacking the swipe for scrolling
            swipeZone.style.display = "flex";
            swipeZone.style.justifyContent = "center";
            
            // 2. Add a subtle Android-style pill indicator so you know exactly where to flick
            //const pill = document.createElement('div');
            //pill.style.width = "40px";
            //pill.style.height = "5px";
            //pill.style.backgroundColor = "rgba(0, 229, 255, 0.3)";
            //pill.style.borderRadius = "3px";
            //pill.style.marginTop = "12px";
            //swipeZone.appendChild(pill);
            container.appendChild(swipeZone);

            let startY = 0;
            let startTime = 0;
            let isSwiping = false;

            // 3. Attach gesture strictly to the top shield so the iframe cannot swallow it
            swipeZone.addEventListener('pointerdown', (e) => {
                isSwiping = true;
                startY = e.clientY;
                startTime = Date.now();
                try { swipeZone.setPointerCapture(e.pointerId); } catch(err) {}
            });

            swipeZone.addEventListener('pointerup', (e) => {
                if (!isSwiping) return;
                isSwiping = false;
                try { swipeZone.releasePointerCapture(e.pointerId); } catch(err) {}

                let deltaY = e.clientY - startY;
                let deltaTime = Date.now() - startTime;
                
                // The Rule: Tap and immediately flick down (more than 40px in under 400ms)
                if (deltaY > 40 && deltaTime < 400) {
                    container.classList.toggle('theater-mode');
                }
            });

            // Laptop fallback: double-click the top handle
            swipeZone.addEventListener('dblclick', () => {
                container.classList.toggle('theater-mode');
            });
        }
    }
}

function updateFragmentVisibility() {
    const fragments = document.querySelectorAll('.fragment');
    let lastWipeStep = -1;
    
    fragments.forEach(el => {
        const step = parseInt(el.getAttribute('data-step'));
        const isWipe = el.getAttribute('data-clear-screen') === 'true';
        if (step <= currentRevealStep && isWipe) {
            lastWipeStep = Math.max(lastWipeStep, step);
        }
    });

    fragments.forEach(el => {
        const step = parseInt(el.getAttribute('data-step'));
        if (step < lastWipeStep || step > currentRevealStep) {
            el.classList.remove('visible', 'no-anim');
        } else {
            if (step < currentRevealStep) {
                el.classList.add('visible', 'no-anim');
            } else if (step === currentRevealStep) {
                    el.classList.add('visible');
                    el.classList.remove('no-anim');
                    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        });

    if (!currentDeck || !currentDeck.slides[currentSlideIndex]) return;
    const slide = currentDeck.slides[currentSlideIndex];
    const currentFrag = slide.theory_fragments.find(f => f.reveal_step === currentRevealStep);

    if (currentFrag && currentFrag.video_sync_time !== undefined && currentFrag.video_sync_time !== null) {
        const targetSyncTime = parseFloat(currentFrag.video_sync_time);
        if (window.cachedUiState === 2 && window.cachedMediaPanel) {
            const activeVid = window.cachedMediaPanel.querySelector('video');
            if (activeVid) {
                activeVid.currentTime = targetSyncTime;
                activeVid.play();
            } else {
                const activeYt = window.cachedMediaPanel.querySelector('iframe');
                if (activeYt && activeYt.src.includes('youtube.com')) {
                    activeYt.contentWindow.postMessage(JSON.stringify({"event": "command", "func": "seekTo", "args": [targetSyncTime, true]}), '*');
                    activeYt.contentWindow.postMessage(JSON.stringify({"event": "command", "func": "playVideo", "args": ""}), '*');
                }
            }
        }
    }
}

function nextStep() {
    if (!currentDeck) return;
    if (currentRevealStep < maxStepsOnSlide) {
        currentRevealStep++;
        updateFragmentVisibility(); 
    } else if (currentSlideIndex < currentDeck.slides.length - 1) {
        currentSlideIndex++;
        currentRevealStep = 1;
        renderSlide();
        if (typeof updateSidebar === "function") updateSidebar();
        if (typeof clearSlideInk === "function") clearSlideInk();
    }
}

function prevStep() {
    if (!currentDeck) return;
    if (currentRevealStep > 1) {
        currentRevealStep--;
        updateFragmentVisibility();
    } else if (currentSlideIndex > 0) {
        currentSlideIndex--;
        const prevSlide = currentDeck.slides[currentSlideIndex];
        currentRevealStep = Math.max(...prevSlide.theory_fragments.map(f => f.reveal_step || 1), 1);
        renderSlide();
        if (typeof updateSidebar === "function") updateSidebar();
        if (typeof clearSlideInk === "function") clearSlideInk();
    }
}

// Global Click Arbiter
window.addEventListener('click', (e) => {
    if (isIntroActive) {
        dismissIntro();
        return;
    }
    
    const drawer = document.getElementById('slideNavDrawer');
    if (drawer && drawer.classList.contains('open') && !e.target.closest('.slide-nav-drawer') && !e.target.closest('.nav-toggle-btn')) {
        drawer.classList.remove('open');
        return;
    }

    if ((typeof isPenLocked !== 'undefined' && isPenLocked) || 
        (typeof isPenDrawing !== 'undefined' && isPenDrawing) || 
        e.target.closest('button')) {
        return;
    }
    if (e.target.closest('.media-drawer') || 
        e.target.closest('.media-strip') ||
        e.target.closest('.media-preview-panel') ||
        e.target.closest('.drawer-toggle-btn') || 
        e.target.closest('.floating-blackboard') ||
        e.target.closest('.slide-nav-drawer')) {
        return;
    }
    
    // --- Main Screen Click Zones (Left 1/3 = Prev, Right 2/3 = Next) ---
    if (e.clientX < window.innerWidth / 3) {
        prevStep();
    } else {
        nextStep();
    }
});

// --- Touch Gestures (Tablet Swipe for Next/Prev) ---
let touchStartX = 0;
let touchEndX = 0;

window.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

window.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    if (typeof isPenModeActive !== 'undefined' && isPenModeActive) return; 
    
    const swipeThreshold = 60;
    if (touchEndX < touchStartX - swipeThreshold) nextStep();
    if (touchEndX > touchStartX + swipeThreshold) prevStep();
}, { passive: true });