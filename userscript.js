(function () {
  "use strict";

  let TARGET_FOUND = false;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getJSON = async (url, options = {}) => {
    const res = await fetch(url, options);
    if (!res.ok) {
      if (res.status === 429) {
        for (let retry = 0; retry < 3; retry++) {
          await delay(2000 * Math.pow(1.5, retry));
          const retryRes = await fetch(url, options);
          if (retryRes.ok) return await retryRes.json();
        }
        throw new Error(`Rate limited after retries: ${res.status}`);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  };

  const getUserId = async (name) => {
    try {
      const data = await getJSON("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }),
      });
      return data.data?.[0]?.id || null;
    } catch (e) {
      console.error("User ID fetch error:", e);
      return null;
    }
  };

  const getThumb = async (userId) => {
    try {
      const data = await getJSON("https://thumbnails.roblox.com/v1/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            type: "AvatarHeadShot",
            targetId: userId,
            format: "png",
            size: "150x150",
          },
        ]),
      });
      return data.data?.[0]?.imageUrl || null;
    } catch (e) {
      console.error("Thumb fetch error:", e);
      return null;
    }
  };

  const getServers = async (placeId, cursor = "") => {
    let url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&excludeFullGames=false&limit=100`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    try {
      return await getJSON(url);
    } catch (e) {
      console.error("Servers fetch error:", e);
      return null;
    }
  };

  const fetchThumbs = async (tokens, requestIds) => {
    const body = tokens.map((token, index) => ({
      type: "AvatarHeadShot",
      token: token,
      format: "png",
      size: "150x150",
      requestId: requestIds[index],
    }));
    try {
      return await getJSON("https://thumbnails.roblox.com/v1/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error("Thumbs fetch error:", e);
      return null;
    }
  };

  async function searchServers(placeId, targetUrl, cursor = "", pageNum = 1, setStatus) {
    if (TARGET_FOUND) {
      return { found: false, aborted: true };
    }

    setStatus(`Loading servers page ${pageNum}. Cursor: ${cursor || "initial"}`);
    await delay(100);

    const serversRes = await getServers(placeId, cursor);
    if (!serversRes || !serversRes.data || serversRes.data.length === 0) {
      setStatus(`No servers found on page ${pageNum}`);
      return { found: false, error: "No servers found" };
    }

    if (TARGET_FOUND) {
      return { found: false, aborted: true };
    }

    const servers = serversRes.data;
    const totalPlayers = servers.reduce((sum, s) => sum + s.playerTokens.length, 0);
    setStatus(`Page ${pageNum}: Processing ${servers.length} servers with ${totalPlayers} players`);

    servers.sort((a, b) => {
      const playerDiff = b.playerTokens.length - a.playerTokens.length;
      if (playerDiff !== 0) return playerDiff;
      return (a.ping || 999) - (b.ping || 999);
    });

    const allTokens = [];
    const requestIds = [];
    const serverMap = {};
    for (const server of servers) {
      serverMap[server.id] = server;
      for (const token of server.playerTokens) {
        allTokens.push(token);
        requestIds.push(server.id);
      }
    }

    const BATCH_SIZE = 100;
    const MAX_CONCURRENT_BATCHES = 4;
    const batches = [];
    for (let i = 0; i < allTokens.length; i += BATCH_SIZE) {
      batches.push({
        tokens: allTokens.slice(i, i + BATCH_SIZE),
        requestIds: requestIds.slice(i, i + BATCH_SIZE),
      });
    }

    setStatus(`Processing ${batches.length} batches in groups of ${MAX_CONCURRENT_BATCHES}`);

    let matchFound = false;
    let foundServerId = null;

    for (let i = 0; i < batches.length && !matchFound && !TARGET_FOUND; i += MAX_CONCURRENT_BATCHES) {
      if (TARGET_FOUND) break;
      const batchGroup = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
      const batchPromises = batchGroup.map(async (batch, idx) => {
        if (TARGET_FOUND) return { found: false, aborted: true };
        try {
          setStatus(`Starting batch ${i + idx + 1}/${batches.length} with ${batch.tokens.length} tokens`);
          const profileRes = await fetchThumbs(batch.tokens, batch.requestIds);
          if (!profileRes?.data) {
            return { found: false };
          }

          const profileMap = {};
          profileRes.data.forEach((profile, j) => {
            if (j < batch.tokens.length && profile.imageUrl) {
              profileMap[batch.tokens[j]] = {
                imageUrl: profile.imageUrl,
                requestId: profile.requestId,
              };
            }
          });

          for (let j = 0; j < batch.tokens.length; j++) {
            if (TARGET_FOUND) return { found: false, aborted: true };
            const token = batch.tokens[j];
            const profile = profileMap[token];
            if (profile && profile.imageUrl === targetUrl) {
              const serverId = profile.requestId;
              setStatus(`\nMATCH FOUND! Token: ${token.slice(0, 10)}... Server ID: ${serverId}`);
              TARGET_FOUND = true;
              return { found: true, serverId, token };
            }
          }
          return { found: false };
        } catch (error) {
          if (TARGET_FOUND) return { found: false, aborted: true };
          console.error(`Batch ${i + idx + 1} error:`, error);
          return { found: false, error: error.message };
        }
      });

      const results = await Promise.all(batchPromises);
      const matchResult = results.find((r) => r?.found);
      if (matchResult) {
        matchFound = true;
        foundServerId = matchResult.serverId;
        TARGET_FOUND = true;
        setStatus(`Found match in batch ${Math.floor(i / MAX_CONCURRENT_BATCHES) + 1}`);
        break;
      }
    }

    if (matchFound && foundServerId && serverMap[foundServerId]) {
      const foundServer = serverMap[foundServerId];
      setStatus(`\nTARGET FOUND! Server ID: ${foundServerId}`);
      console.log("Server details:", foundServer);
      return {
        found: true,
        place: foundServer,
      };
    }

    if (TARGET_FOUND) {
      return { found: false, aborted: true };
    }

    if (serversRes.nextPageCursor && !TARGET_FOUND) {
      setStatus(`Pre-fetching next page (${pageNum + 1})...`);
      const nextResult = await searchServers(placeId, targetUrl, serversRes.nextPageCursor, pageNum + 1, setStatus);
      return nextResult;
    } else {
      setStatus("Finished all server pages. Target not found");
      return { found: false };
    }
  }

  const search = async (placeId, name, setStatus, cb, setThumb) => {
    TARGET_FOUND = false;
    setStatus(`Starting search for ${name} in game ${placeId}`);

    const userId = await getUserId(name);
    if (!userId) {
      setStatus("User not found");
      return cb({ found: false });
    }

    const thumbUrl = await getThumb(userId);
    if (!thumbUrl) {
      setStatus("Could not get profile image");
      return cb({ found: false });
    }

    setStatus(`Target: ${name} ID: ${userId} Profile: ${thumbUrl}`);
    setThumb(thumbUrl);

    const result = await searchServers(placeId, thumbUrl, "", 1, setStatus);

    if (result.found) {
      setStatus("Target found!");
      cb(result);
    } else if (!TARGET_FOUND) {
      setStatus("Target not found in any server");
      cb({ found: false });
    } else {
      setStatus("Target found elsewhere");
      cb({ found: true });
    }
  };

  const instancesContainer = document.getElementById("running-game-instances-container");
  if (instancesContainer) {
    const containerHeader = document.createElement("div");
    containerHeader.classList.add("section");

    const thumbImage = document.createElement("img");
    thumbImage.height = "40";
    thumbImage.style.display = "none";
    containerHeader.appendChild(thumbImage);

    const form = document.createElement("form");
    const usernameInput = document.createElement("input");
    usernameInput.classList.add("input-field");
    usernameInput.placeholder = "Username";
    form.appendChild(usernameInput);

    const submitButton = document.createElement("button");
    submitButton.classList.add("btn-primary-md");
    submitButton.innerText = "Search";
    submitButton.disabled = true;
    form.appendChild(submitButton);

    const statusText = document.createElement("p");
    statusText.style.marginTop = "0.5rem";
    form.appendChild(statusText);

    usernameInput.addEventListener("input", (e) => {
      submitButton.disabled = e.target.value.length === 0;
    });

    const joinBtn = document.createElement("button");
    joinBtn.style.display = "none";
    joinBtn.innerText = "Join Server";
    joinBtn.className =
      "btn-control-xs rbx-game-server-join game-server-join-btn btn-primary-md btn-min-width";
    containerHeader.appendChild(joinBtn);

    containerHeader.insertBefore(form, joinBtn);

    instancesContainer.insertBefore(containerHeader, instancesContainer.firstChild);

    const placeId = location.href.match(/\d+/)?.[0];
    if (!placeId) {
      statusText.innerText = "Could not detect place ID";
      return;
    }

    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      joinBtn.style.display = "none";
      thumbImage.style.display = "none";
      submitButton.disabled = true;
      submitButton.innerText = "Searching...";
      search(
        placeId,
        usernameInput.value.trim(),
        (txt) => {
          console.log(txt);
          statusText.innerText = txt;
        },
        (result) => {
          submitButton.disabled = false;
          submitButton.innerText = "Search";
          if (!result.found) {
            statusText.innerText = "Couldn't find them";
            return;
          }
          joinBtn.style.display = "inline-block";
          joinBtn.onclick = () => {
            if (window.Roblox?.GameLauncher) {
              window.Roblox.GameLauncher.joinGameInstance(placeId, result.place.id);
            } else {
              console.error("Roblox.GameLauncher not available");
            }
          };
        },
        (src) => {
          thumbImage.src = src;
          thumbImage.style.display = "inline-block";
        }
      );
    });
  } else {
    console.log("RoSniper: Not on a game page with instances container");
  }
})();
