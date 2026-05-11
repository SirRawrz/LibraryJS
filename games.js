/* Media Server Games Catalog
   Editable game tiles and special disc handlers moved out of index.html
   so the admin page can manage this list separately.
*/

// Add "Games" to the list of folders
    folders.push("Games");

    // Define the list of games and their respective emulator links
    const games = [
 { name: "Hollow Knight, Unity", img: "./Images/Hollow Knight.jpg", link: "./emulator/Unity/hollow-knight-main/index.html" },
  { name: "Minecraft", img: "./Images/Minecraft.jpg", link: "./emulator/Unity/play/minecraft/index.html" },
//	{ name: "PS2, Experimental", img: "./PlayJS/PlayJS.jpg", link: "https://192.168.0.32:8000/playjs.html" },
 // { name: "Jeanne D'Arc", img: "./Images/jda.jpg", link: "https://192.168.0.237:8081/emulator/indexpsp.html?rom=jda.iso" }, 
			   { name: "Digimon World 3, Playstation", img: "./Images/dw3.jpg", link: "./emulator/indexpsx.html?rom=DigimonWorld3.chd" },
		//		{ name: "Final Fantasy IX, Low Performance Devices", img: "./Images/ff9.jpg", link: "./emulator/indexps1lowp.html?rom=ff9-1.bin" },
		//			{ name: "Final Fantasy Tactics, Playstation", img: "./Images/fft.jpg", link: "./emulator/indexpsx.html?rom=fft.chd" },
	//			{ name: "Final Fantasy VII, Playstation", img: "./Images/ff7.jpg", link: "./emulator/indexpsx.html?rom=ff7-1.iso" },
		//		{ name: "Final Fantasy VIII, Playstation", img: "./Images/ff8.jpg", link: "./emulator/indexpsx.html?rom=ff8-1.bin" },
		//		{ name: "Final Fantasy IX, Playstation", img: "./Images/Final Fantasy IX - Disk 1.jpg", link: "./emulator/indexpsx.html?rom=finalfantasyix-disk1.bin" },
		//	   { name: "Digimon World 3, Playstation", img: "./Images/dw3.jpg", link: "./emulator/indexpsx.html?rom=dw3.chd" },
		//			        { name: "Digimon World 3, Low Performance Devices", img: "./Images/dw3.jpg", link: "./emulator/indexps1lowp.html?rom=dw3.chd" },
		//		{ name: "Final Fantasy IX, Low Performance Devices", img: "./Images/ff9.jpg", link: "./emulator/indexps1lowp.html?rom=ff9-1.bin" },
					{ name: "Final Fantasy Tactics, Playstation", img: "./Images/FinalFantasyTactics.jpg", link: "./emulator/indexpsx.html?rom=FinalFantasyTactics.chd" },
				{ name: "Final Fantasy VII, Playstation", img: "./Images/ff7.jpg", link: "./emulator/indexpsx.html?rom=ff7-1.iso" },
				{ name: "Final Fantasy VIII, Playstation", img: "./Images/ff8.jpg", link: "./emulator/indexpsx.html?rom=ff8-1.bin" },
				{ name: "Final Fantasy IX, Playstation", img: "./Images/Final Fantasy IX.jpg", link: "./emulator/indexpsx.html?rom=Final Fantasy IX - Disk 1.bin" },
								  { name: "Pokemon Trading Card Game, GBC", img: "./Images/pokemontcg.jpg", link: "./emulator/indexgb.html?rom=pokemontcg.gbc" },
								 { name: "Pokemon Blue, GB", img: "./Images/pokemonblue.jpg", link: "./emulator/indexgb.html?rom=pokemonblue.gb" },
								  { name: "Pokemon Red, GB", img: "./Images/pokemonred.jpg", link: "./emulator/indexgb.html?rom=pokemonred.gb" },
								   { name: "Pokemon Yellow, GBC", img: "./Images/pokemonyellow.jpg", link: "./emulator/indexgb.html?rom=pokemonyellow.gbc" },
								   { name: "Pokemon Gold, GBC", img: "./Images/pokemongold.jpg", link: "./emulator/indexgb.html?rom=pokemongold.gbc" },
								    { name: "Pokemon Silver, GBC", img: "./Images/pokemonsilver.jpg", link: "./emulator/indexgb.html?rom=pokemonsilver.gbc" },
									  { name: "Pokemon Crystal, GBC", img: "./Images/pokemoncrystal.jpg", link: "./emulator/indexgb.html?rom=pokemoncrystal.gbc" },
									  { name: "Pokemon Battle Stadium, N64", img: "./Images/pokestadium.jpg", link: "./emulator/indexn64.html?rom=pokestadium.z64" },
				   { name: "Pokemon Battle Stadium 2, N64", img: "./Images/pokestadium2.jpg", link: "./emulator/indexn64.html?rom=pokestadium2.z64" },
				  { name: "Pokemon Snap, N64", img: "./Images/pokemonsnap.jpg", link: "./emulator/indexn64.html?rom=pokemonsnap.n64" },
				   { name: "Fire Emblem - The Sacred Stones, GBA", img: "./Images/fireemblem-thesacredstones.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=fireemblem-thesacredstones.gba" },								 
									 { name: "Pokemon Fire Red, GBA", img: "./Images/pokemonfirered.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonfirered.gba" },
									  { name: "Pokemon Leaf Green, GBA", img: "./Images/pokemonleafgreen.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonleafgreen.gba" },
									   { name: "Pokemon Radical Red, GBA", img: "./Images/pokemonradicalred.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonradicalred.gba" },
									    { name: "Pokemon The Last Fire Red, GBA", img: "./Images/pokemonthelastfirered.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonthelastfirered.gba" },
										 { name: "Pokemon Heart & Soul, GBA", img: "./Images/pokemonheartnsoul.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonheartnsoul.gba" },
										  { name: "Pokemon Hearth, GBA", img: "./Images/pokemonhearth.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonhearth.gba" },
										  										 { name: "Pokemon Lazarus, GBA", img: "./Images/pokemonlazarus.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonlazarus.gba" },
									    { name: "Pokemon Unbound, GBA", img: "./Images/pokemon-unbound.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemon-unbound.gba" },
										 { name: "Pokemon Quetzal, GBA", img: "./Images/pokemonquetzal.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonquetzal.gba" },
 { name: "Pokemon Sword and Shield Ultimate, GBA", img: "./Images/pokemonswordshieldultimate.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonswordshieldultimate.gba" },
{ name: "Pokemon World Stadium, GBA", img: "./Images/pokemonworldstadium.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonworldstadium.gba" },
									   { name: "Pokemon Ruby, GBA", img: "./Images/pokemonruby.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonruby.gba" },
									    { name: "Pokemon Sapphire, GBA", img: "./Images/pokemonsapphire.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemonsapphire.gba" },
									    { name: "Pokemon Emerald, GBA", img: "./Images/pokemon-emerald.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=pokemon-emerald.gba" },
				  			    { name: "Pokemon Heart Gold, Nintendo DS", img: "./Images/ndspokemonheartgold.jpg", link: "./emulator/indexnds.html?rom=ndspokemonheartgold.nds" },
				  { name: "Pokemon Soul Silver, Nintendo DS", img: "./Images/ndspokemonsoulsilver.jpg", link: "./emulator/indexnds.html?rom=ndspokemonsoulsilver.nds" },
				      { name: "Pokemon Black, Nintendo DS", img: "./Images/pokemonblack.jpg", link: "./emulator/indexnds.html?rom=pokemonblack.nds" },
				  { name: "Pokemon White, Nintendo DS", img: "./Images/pokemonwhite.jpg", link: "./emulator/indexnds.html?rom=pokemonwhite.nds" },
				  			    { name: "Pokemon Black 2, Nintendo DS", img: "./Images/pokemonblack2.jpg", link: "./emulator/indexnds.html?rom=pokemonblack2.nds" },
				  { name: "Pokemon White 2, Nintendo DS", img: "./Images/pokemonwhite2.jpg", link: "./emulator/indexnds.html?rom=pokemonwhite2.nds" },
				    { name: "Pokemon Platinum, Nintendo DS", img: "./Images/pokemonplatinum.jpg", link: "./emulator/indexnds.html?rom=pokemonplatinum.nds" },
				  	
				  { name: "Scribblenauts, Nintendo DS", img: "./Images/scribblenauts.jpg", link: "./emulator/indexnds.html?rom=scribblenauts.nds" },
		{ name: "Zelda Link's Awakening, GBC", img: "./Images/zeldalinksawakening.jpg", link: "./emulator/indexgb.html?rom=zeldalinksawakening.gbc" },
		{ name: "Zelda Oracle of Seasons, GBC", img: "./Images/zeldaoracleseasons.jpg", link: "./emulator/indexgb.html?rom=zeldaoracleseasons.gbc" },
		{ name: "Zelda Oracle of Ages, GBC", img: "./Images/zeldaoracleages.jpg", link: "./emulator/indexgb.html?rom=zeldaoracleages.gbc" },
		 { name: "The Legend of Zelda Ocarina of Time, N64", img: "./Images/zeldaocarinaoftime.jpg", link: "./emulator/indexn64.html?rom=zeldaocarinaoftime.z64" },
		        { name: "Harry Potter, GBC", img: "./Images/harrypotter.jpg", link: "./emulator/indexgb.html?rom=harrypotter.gbc" },
   { name: "Harry Potter and the Philospher's Stone, Playstation", img: "./Images/harrypotterps1.jpg", link: "./emulator/indexpsx.html?rom=harrypotterps1.chd" },
			   { name: "Harry Potter and the Chamber of Secrets, Playstation", img: "./Images/harrypotterchamberofsecretsps1.jpg", link: "./emulator/indexpsx.html?rom=harrypotterchamberofsecretsps1.pbp" },				
				{ name: "Kirby Nightmare in Dreamland, GBA", img: "./Images/kirbynightmareindreamland.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=kirbynightmareindreamland.gba" },
									 { name: "Skyland, GBA", img: "./Images/skyland.jpg", link: "https://192.168.254.16:8081/emulator/indexgba.html?rom=skyland.gba" },
									  { name: "Elden Ring (Demake), GB", img: "./Images/eldenring(demake)gb.jpg", link: "./emulator/indexgb.html?rom=eldenring(demake)gb.gb" },
				{ name: "Marvel Super Heros, Playstation", img: "./Images/marvelsuperherosps1.jpg", link: "./emulator/indexpsx.html?rom=marvelsuperherosps1.pbp" },
					{ name: "Marvel vs. Capcom Clash of the Super Heros, Playstation", img: "./Images/marvelvscapcom.jpg", link: "./emulator/indexpsx.html?rom=marvelvscapcom.pbp"},
					{ name: "Spyro the Dragon", img: "./Images/spyrothedragon.jpg", link: "./emulator/indexpsx.html?rom=spyrothedragon.pbp" },
					{ name: "Inuyasha - Fuedal Fairy Tale, Playstation", img: "./Images/inuyashafft.jpg", link: "./emulator/indexpsx.html?rom=inuyashafft.pbp" },
				     { name: "Castlevania Symphony of the Night, Playstation", img: "./Images/castlevaniasymphony.jpg", link: "./emulator/indexpsx.html?rom=castlevaniasymphony.pbp" },				
				{ name: "Castlevania Chronicles, Playstation", img: "./Images/castlevaniachronicles.jpg", link: "./emulator/indexpsx.html?rom=castlevaniachronicles.pbp" },
			//		{ name: "Cabela's Ultimate Deer Hunt, Playstation", img: "./Images/cabelasdeerhunt.jpg", link: "./emulator/indexpsx.html?rom=cabelasdeerhunt.zip" },
					{ name: "Harvest Moon, Playstation", img: "./Images/hm.jpg", link: "./emulator/indexpsx.html?rom=hm.pbp" },
			//	{ name: "Twisted Metal, Playstation", img: "./Images/twistedmetal.jpg", link: "./emulator/indexpsx.html?rom=twistedmetal.bin" },
				{ name: "Twisted Metal 4, Playstation", img: "./Images/twistedmetal4.jpg", link: "./emulator/indexpsx.html?rom=twistedmetal4.pbp" },
					 { name: "Chocobo Racing, Playstation", img: "./Images/chocoboracing.jpg", link: "./emulator/indexpsx.html?rom=chocoboracing.pbp" },
					  { name: "Chocobo's Dungeon 2, Playstation", img: "./Images/chocobosdungeon2.jpg", link: "./emulator/indexpsx.html?rom=chocobosdungeon2.pbp" },
					   { name: "Crash Bandicoot, Playstation", img: "./Images/crashbandicoot.jpg", link: "./emulator/indexpsx.html?rom=crashbandicoot.pbp" },
		{ name: "Yu-Gi-Oh! Forbidden Memories, Playstation", img: "./Images/yugiohfm.jpg", link: "./emulator/indexpsx.html?rom=yugiohfm.pbp" },
	//	---------- { name: "Marvel Super Heros, Sega Saturn", img: "./Images/marvelsuperheros.jpg", link: "./emulator/indexsegaSaturn.html?rom=marvelsuperheros.chd" },
			 { name: "Resident Evil, Playstation", img: "./Images/residentevil.jpg", link: "./emulator/indexpsx.html?rom=residentevil.pbp" },
			 { name: "Silent Hill, Playstation", img: "./Images/silenthill.jpg", link: "./emulator/indexpsx.html?rom=silenthill.pbp" },
			 { name: "Spiderman, Playstation", img: "./Images/spiderman.jpg", link: "./emulator/indexpsx.html?rom=spiderman.pbp" },
			 { name: "spiderman2 Enter Electro, Playstation", img: "./Images/spiderman2electro.jpg", link: "./emulator/indexpsx.html?rom=spiderman2electro.pbp" },
				     { name: "007 - Goldeneye, N64", img: "./Images/007goldeneye.jpg", link: "./emulator/indexn64.html?rom=007goldeneye.n64" },
					      { name: "Legend of Zelda, Majora's Mask, N64", img: "./Images/legendofzeldamajorasmask.jpg", link: "./emulator/indexn64.html?rom=legendofzeldamajorasmask.z64" },
						       { name: "Super Smash Bros, N64", img: "./Images/SuperSmashBros.jpg", link: "./emulator/indexn64.html?rom=SuperSmashBros.z64" },
  { name: "Mario Kart 64, N64", img: "./Images/Mario Kart 64.jpg", link: "./emulator/indexn64.html?rom=MarioKart64.z64" },		
  { name: "Mario Party, N64", img: "./Images/marioparty.jpg", link: "./emulator/indexn64.html?rom=MarioParty.z64" },	
  { name: "Mario Party 2, N64", img: "./Images/marioparty2.jpg", link: "./emulator/indexn64.html?rom=MarioParty2.z64" },	  
								   { name: "Super Mario 64, N64", img: "./Images/SuperMario64.jpg", link: "./emulator/indexn64.html?rom=SuperMario64.z64" },
							{ name: "Lion King, SEGA", img: "./Images/lionking.jpg", link: "./emulator/indexsega.html?rom=lionking.smd" },
								{ name: "Ms. Pacman, SEGA", img: "./Images/mspacman.jpg", link: "./emulator/indexsega.html?rom=mspacman.md" },
				{ name: "Frogger, SEGA", img: "./Images/frogger.jpg", link: "./emulator/indexsega.html?rom=frogger.md" },
{ name: "Castlevania Bloodlines, SEGA", img: "./Images/castlevaniabloodlines.jpg", link: "./emulator/indexsega.html?rom=castlevaniabloodlines.smd" },
{ name: "Street Fighter III 3rd Strike: Fight for the Future", img: "./Images/sfiii3.jpg", link: "./emulator/indexarcade.html?rom=sfiii3.zip" },
{ name: "Jack the Giant Killer", img: "./Images/jack.jpg", link: "./emulator/indexarcade.html?rom=jack.zip" },
 { name: "Castlevania Dracula X, Super Nintendo", img: "./Images/castlevaniadraculax.jpg", link: "./emulator/indexsnes.html?rom=castlevaniadraculax.sfc" }, 
  { name: "Chrono Trigger, Super Nintendo", img: "./Images/chronotrigger.jpg", link: "./emulator/indexsnes.html?rom=chronotrigger.sfc" },
   { name: "Final Fantasy II, Super Nintendo", img: "./Images/ff2.jpg", link: "./emulator/indexsnes.html?rom=ff2.sfc" },
    { name: "Final Fantasy III, Super Nintendo", img: "./Images/ff3.jpg", link: "./emulatorindexsnes.html?rom=ff3.sfc" },
	 { name: "Super Mario World, Super Nintendo", img: "./Images/SuperMarioWorld.jpg", link: "./emulator/indexsnes.html?rom=SuperMarioWorld.sfc" },
	  { name: "Kirby Dreamland 3, Super Nintendo", img: "./Images/kirbysdreamland3.jpg", link: "./emulator/indexsnes.html?rom=kirbysdreamland3.sfc" },
	   { name: "Kirby Super Star, Super Nintendo", img: "./Images/kirbysuperstar.jpg", link: "./emulator/indexsnes.html?rom=kirbysuperstar.sfc" }
	//   	   { name: "Mixed-Up Fairy Tales, Windows 95", img: "./Images/kirbysuperstar.jpg", link: "./emulator/indexsnes.html?rom=kirbysuperstar.sfc" },
	//   	{ name: "Guidebooks", img: "./Images/guidebooks.jpg", link: "./guidebooks.html" }
        // Add more games here
    ];

    // Modify function to handle "Games" folder click
    function openFolder(folderName) {
        if (folderName === "Games") {
            displayGames();
        } else {
            // Existing logic for opening video folders
            currentFolder = folderName;
            displayEpisodes(folderName);
        }
    }
		     const backButton = document.createElement("button");
        backButton.className = "return-button";
        backButton.innerText = "Back to Title Selection";
        backButton.onclick = () => {
            folderContainer.innerHTML = "";
            loadMainFolders();
        };
        folderContainer.appendChild(backButton);

function displayGames() {
    const container = document.getElementById("folderContainer");
    container.innerHTML = "";

    // Add Back Button at the START
    const backButtonTop = document.createElement("button");
    backButtonTop.className = "return-button";
    backButtonTop.innerText = "Back to Title Selection";
    backButtonTop.onclick = () => {
        folderContainer.innerHTML = "";
        loadMainFolders();
    };
    container.appendChild(backButtonTop); // Add first

    games.forEach(game => {
        if (game.name.startsWith("Final Fantasy IX")) {
            createGameTile(container, "Final Fantasy IX, Playstation", "./Images/Final Fantasy IX.jpg", displayFF9Disks);
        } else if (game.name.startsWith("Final Fantasy VIII")) {
            createGameTile(container, "Final Fantasy VIII, Playstation", "./Images/ff8.jpg", displayFF8Disks);
        } else if (game.name.startsWith("Final Fantasy VII")) {
            createGameTile(container, "Final Fantasy VII, Playstation", "./Images/ff7.jpg", displayFF7Disks);
        } else {
            // Other games remain unchanged
            const gameTile = document.createElement("div");
            gameTile.classList.add("folder");
            gameTile.innerHTML = `
                <img src="${game.img}" alt="${game.name}" onclick="window.location.href='${game.link}'">
                <p>${game.name}</p>
            `;
            container.appendChild(gameTile);
        }
    });

    // Existing Back Button at the END
    const backButtonBottom = document.createElement("button");
    backButtonBottom.className = "return-button";
    backButtonBottom.innerText = "Back to Title Selection";
    backButtonBottom.onclick = () => {
        folderContainer.innerHTML = "";
        loadMainFolders();
    };
    container.appendChild(backButtonBottom);
}

// Helper function to create a game tile with click event
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

// Function to display FF7 Disks
function displayFF7Disks() {
    displayDisks("Final Fantasy VII", [
        { disk: 1, link: "./emulator/indexpsx.html?rom=FinalFantasyVII-Disk1.iso" },
        { disk: 2, link: "./emulator/indexpsx.html?rom=FinalFantasyVII-Disk2.bin" },
        { disk: 3, link: "./emulator/indexpsx.html?rom=FinalFantasyVII-Disk3.bin" }
    ]);
}

// Function to display FF8 Disks
function displayFF8Disks() {
    displayDisks("Final Fantasy VIII", [
        { disk: 1, link: "./emulator/indexpsx.html?rom=FinalFantasyVIII-Disk1.bin" },
        { disk: 2, link: "./emulator/indexpsx.html?rom=FinalFantasyVIII-Disk2.bin" },
        { disk: 3, link: "./emulator/indexpsx.html?rom=FinalFantasyVIII-Disk3.bin" },
        { disk: 4, link: "./emulator/indexpsx.html?rom=FinalFantasyVIII-Disk4.bin" }
    ]);
}

// Function to display FF9 Disks
function displayFF9Disks() {
    displayDisks("Final Fantasy IX", [
        { disk: 1, link: "./emulator/indexpsx.html?rom=FinalFantasyIX-Disk1.bin" },
        { disk: 2, link: "./emulator/indexpsx.html?rom=FinalFantasyIX-Disk2.bin" },
        { disk: 3, link: "./emulator/indexpsx.html?rom=FinalFantasyIX-Disk3.bin" },
        { disk: 4, link: "./emulator/indexpsx.html?rom=FinalFantasyIX-Disk4.bin" }
    ]);
}

// General function to display disks for a given game
// General function to display disks for a given game
// General function to display disks for a given game
function displayDisks(gameName, disks) {
    const container = document.getElementById("folderContainer");
    container.innerHTML = "";

    disks.forEach(disk => {
        const diskTile = document.createElement("div");
        diskTile.classList.add("folder");
        diskTile.innerHTML = `
            <img src="./Images/${gameName.toLowerCase().replace(/ /g, "")}-${disk.disk}.jpg" alt="${gameName} - Disk ${disk.disk}" onclick="window.location.href='${disk.link}'">
            <p>${gameName} - Disk ${disk.disk}</p>
        `;
        container.appendChild(diskTile);
    });

    // Back Button to return to the main Games list
    const backButton = document.createElement("button");
    backButton.className = "return-button";
    backButton.innerText = "Back to Games";
    backButton.onclick = displayGames;
    container.appendChild(backButton);
}



// Make the catalog available to older code paths as well.
window.games = games;
window.displayGames = displayGames;
window.createGameTile = createGameTile;
window.displayFF7Disks = displayFF7Disks;
window.displayFF8Disks = displayFF8Disks;
window.displayFF9Disks = displayFF9Disks;
window.displayDisks = displayDisks;
