/* Media Server Games Catalog
*/

// Add "Games" to the list of folders
folders.push("Games");

// Define the list of games and their respective emulator links
const games = [
];


function displayGames() {
    const container = document.getElementById("folderContainer");
    container.innerHTML = "";

    const backButtonTop = document.createElement("button");
    backButtonTop.className = "return-button";
    backButtonTop.innerText = "Back to Title Selection";
    backButtonTop.onclick = () => {
        folderContainer.innerHTML = "";
        loadMainFolders();
    };
    container.appendChild(backButtonTop);

    games.forEach(game => {
        if (game.specialSet === "multidisk" && Array.isArray(game.disks)) {
            createGameTile(container, game.name || game.baseName, game.img, () => displayDisks(game));
        } else {
            const gameTile = document.createElement("div");
            gameTile.classList.add("folder");
            gameTile.innerHTML = `
                <img src="${game.img}" alt="${game.name}" onclick="window.location.href='${game.link}'">
                <p>${game.name}</p>
            `;
            container.appendChild(gameTile);
        }
    });

    const backButtonBottom = document.createElement("button");
    backButtonBottom.className = "return-button";
    backButtonBottom.innerText = "Back to Title Selection";
    backButtonBottom.onclick = () => {
        folderContainer.innerHTML = "";
        loadMainFolders();
    };
    container.appendChild(backButtonBottom);
}

function createGameTile(container, name, img, onclickFunction) {
    const gameTile = document.createElement("div");
    gameTile.classList.add("folder");
    gameTile.innerHTML = `
        <img src="${img}" alt="${name}">
        <p>${name}</p>
    `;
    gameTile.onclick = onclickFunction;
    container.appendChild(gameTile);
}

function displayDisks(gameOrName, disksOverride) {
    const game = typeof gameOrName === "object" && gameOrName ? gameOrName : {
        baseName: String(gameOrName || ""),
        disks: Array.isArray(disksOverride) ? disksOverride : []
    };
    const disks = Array.isArray(game.disks) ? game.disks : (Array.isArray(disksOverride) ? disksOverride : []);
    const gameName = game.baseName || game.name || "";
    const container = document.getElementById("folderContainer");
    container.innerHTML = "";

    disks.forEach(disk => {
        const diskTile = document.createElement("div");
        diskTile.classList.add("folder");
        const image = disk.img || `./Images/${gameName.toLowerCase().replace(/ /g, "")}-${disk.disk}.jpg`;
        diskTile.innerHTML = `
            <img src="${image}" alt="${gameName} - Disk ${disk.disk}" onclick="window.location.href='${disk.link}'">
            <p>${gameName} - Disk ${disk.disk}</p>
        `;
        container.appendChild(diskTile);
    });

    const backButton = document.createElement("button");
    backButton.className = "return-button";
    backButton.innerText = "Back to Games";
    backButton.onclick = displayGames;
    container.appendChild(backButton);
}

window.games = games;
window.displayGames = displayGames;
window.createGameTile = createGameTile;
window.displayDisks = displayDisks;
