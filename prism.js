"use strict";
// Proximity controls both brightness and how far the light extends.
(() => {
    const scene = document.getElementById("prism-scene");
    const svg = scene.querySelector("svg");
    const light = document.getElementById("halo-pointer");
    const glow = document.getElementById("halo-light");
    const face = document.getElementById("halo-face");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let x = 570, y = 220, tx = x, ty = y;
    let strength = 0, targetStrength = 0, frame = null;
    function edgeDistance(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)));
        return Math.hypot(px-ax-t*dx, py-ay-t*dy);
    }
    function proximity(px, py) {
        const inside = py >= 130 && py <= 407 && Math.abs(px-500) <= (py-130)*160/277;
        const d = inside ? 0 : Math.min(
            edgeDistance(px,py,500,130,660,407),
            edgeDistance(px,py,660,407,340,407),
            edgeDistance(px,py,340,407,500,130));
        return Math.pow(Math.max(0, 1-d/320), 1.5);
    }
    function draw() {
        const ease = reduced.matches ? 1 : .16;
        x += (tx-x)*ease; y += (ty-y)*ease;
        strength += (targetStrength-strength)*ease;
        light.setAttribute("cx", x);
        light.setAttribute("cy", y);
        light.setAttribute("r", 220 + strength*330);
        glow.style.opacity = .14 + strength*.72;
        // Fade the idle light back in as the pointer leaves the triangle.
        const nearTriangle = targetStrength >= .5;
        scene.classList.toggle("pointer-near-triangle", nearTriangle);
        scene.style.setProperty("--idle-opacity", nearTriangle ? 0 : .5);
        // Keep blur on the individual light paths; no group filter rectangle.
        // Expand the diffuse outer light without changing the triangle.
        glow.firstElementChild.setAttribute("transform",
            `translate(500 300) scale(${1+strength*.25}) translate(-500 -300)`);
        frame = null;
        if (Math.abs(tx-x)+Math.abs(ty-y)+Math.abs(targetStrength-strength)*100 > .4)
            frame = requestAnimationFrame(draw);
    }
    function schedule() { if (frame === null) frame = requestAnimationFrame(draw); }
    scene.addEventListener("pointermove", event => {
        const matrix = svg.getScreenCTM();
        if (!matrix) return;
        const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
        tx = point.x; ty = point.y;
        targetStrength = proximity(tx,ty);
        schedule();
    });
    function reset() { tx=570; ty=220; targetStrength=0; schedule(); }
    scene.addEventListener("pointerleave", reset);
    scene.addEventListener("pointercancel", reset);
    scene.addEventListener("pointerup", event => { if(event.pointerType!=="mouse") reset(); });
    function toggleWhite() {
        const white = scene.classList.toggle("white-light");
        const colors = white
            ? ["#ffffff", "#ffffff", "#ffffff", "#ffffff"]
            : ["#b66b88", "#a58bc7", "#88a9cf", "#98b9b4"];
        document.querySelectorAll("#halo-spectrum stop").forEach((stop, index) => {
            stop.setAttribute("stop-color", colors[index]);
        });
        face.setAttribute("aria-pressed", String(white));
        face.setAttribute("aria-label", white ? "Restore colored triangle lighting" : "Use white triangle lighting");
    }
    face.addEventListener("click", toggleWhite);
    face.addEventListener("keydown", event => {
        if(event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleWhite(); }
    });
    schedule();
})();
