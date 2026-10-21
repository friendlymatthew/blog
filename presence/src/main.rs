//! Lets people reading the same blog page see each other's hands, wave hi (high five) and hug.
//!
//! Each page is a room: browsers connect to `/ws?room=<page path>` and only hear about people on
//! the same page. Positions are in page coordinates (x from the middle of the page, y from the top),
//! so hands line up for everyone whatever the size of their window.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Two waving hands closer than this (in px) high five.
const FIVE_DISTANCE: f64 = 70.0;
/// A hand can't high five again until this has passed.
const FIVE_COOLDOWN: Duration = Duration::from_millis(1200);
/// Two people hug when they're both circling around points closer than this (in px).
const HUG_DISTANCE: f64 = 100.0;
const HUG_COOLDOWN: Duration = Duration::from_millis(2500);

/// Limits, since anyone on the internet can connect.
const MAX_CONNECTIONS: usize = 1000;
const MAX_PER_ROOM: usize = 100;
const MAX_ROOM_LEN: usize = 200;
const MAX_MESSAGE_LEN: usize = 300;
/// Positions further than this from the page's origin are ignored.
const MAX_COORD: f64 = 1e6;

const COLORS: &[&str] = &[
    "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

/// The loop a cursor is currently drawing.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct Circle {
    x: f64,
    y: f64,
    r: f64,
}

struct User {
    x: f64,
    y: f64,
    waving: bool,
    circle: Option<Circle>,
    color: &'static str,
    last_five: Option<Instant>,
    last_hug: Option<Instant>,
}

impl User {
    fn can_five(&self, now: Instant) -> bool {
        self.waving && self.last_five.is_none_or(|t| now - t > FIVE_COOLDOWN)
    }

    fn hug_circle(&self, now: Instant) -> Option<Circle> {
        self.circle
            .filter(|_| self.last_hug.is_none_or(|t| now - t > HUG_COOLDOWN))
    }
}

/// Everyone on one page.
struct Room {
    users: HashMap<u64, User>,
    tx: broadcast::Sender<String>,
}

#[derive(Clone)]
struct AppState {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    next_id: Arc<AtomicU64>,
    connections: Arc<AtomicUsize>,
    /// Pages allowed to connect, by their Origin header; empty allows any.
    allowed_origins: Arc<Vec<String>>,
}

/// Messages from a browser.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ClientMsg {
    Move {
        x: f64,
        y: f64,
        waving: bool,
        #[serde(default)]
        circle: Option<Circle>,
    },
}

/// Messages to browsers.
#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ServerMsg<'a> {
    Hello { id: u64, color: &'a str },
    Cursor { id: u64, x: f64, y: f64, waving: bool, circle: Option<Circle>, color: &'a str },
    Bye { id: u64 },
    Five { a: u64, b: u64, x: f64, y: f64 },
    Hug { a: u64, b: u64, x: f64, y: f64 },
}

fn encode(msg: &ServerMsg) -> String {
    serde_json::to_string(msg).expect("server messages always serialize")
}

#[tokio::main]
async fn main() {
    let allowed_origins = std::env::var("ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let state = AppState {
        rooms: Arc::default(),
        next_id: Arc::new(AtomicU64::new(1)),
        connections: Arc::default(),
        allowed_origins: Arc::new(allowed_origins),
    };

    let app = Router::new()
        .route("/", get(|| async { "presence is running" }))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
    let addr = std::env::var("ADDR").unwrap_or_else(|_| format!("0.0.0.0:{port}"));
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("presence listening on ws://{addr}/ws");
    axum::serve(listener, app).await.unwrap();
}

#[derive(Deserialize)]
struct Join {
    room: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(Join { room }): Query<Join>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !state.allowed_origins.is_empty() {
        let origin = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()).unwrap_or("");
        if !state.allowed_origins.iter().any(|o| o == origin) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if room.is_empty() || room.len() > MAX_ROOM_LEN {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if state.connections.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if state.rooms.lock().unwrap().get(&room).is_some_and(|r| r.users.len() >= MAX_PER_ROOM) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.max_message_size(MAX_MESSAGE_LEN)
        .on_upgrade(|socket| handle_socket(socket, state, room))
        .into_response()
}

async fn handle_socket(socket: WebSocket, state: AppState, room: String) {
    state.connections.fetch_add(1, Ordering::Relaxed);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let color = COLORS[(id as usize - 1) % COLORS.len()];
    let (mut sink, mut stream) = socket.split();

    // Join the room. Subscribe before listing who's there so no updates are missed in between.
    let (mut rx, greeting) = {
        let mut rooms = state.rooms.lock().unwrap();
        let room = rooms.entry(room.clone()).or_insert_with(|| Room {
            users: HashMap::new(),
            tx: broadcast::channel(256).0,
        });
        let rx = room.tx.subscribe();
        let mut greeting = vec![encode(&ServerMsg::Hello { id, color })];
        for (&uid, u) in &room.users {
            greeting.push(encode(&ServerMsg::Cursor {
                id: uid,
                x: u.x,
                y: u.y,
                waving: u.waving,
                circle: u.circle,
                color: u.color,
            }));
        }
        room.users.insert(
            id,
            User {
                x: -1e9,
                y: -1e9,
                waving: false,
                circle: None,
                color,
                last_five: None,
                last_hug: None,
            },
        );
        (rx, greeting)
    };

    let mut send_task = tokio::spawn(async move {
        for msg in greeting {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                return;
            }
        }
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if sink.send(Message::Text(msg.into())).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });

    let recv_state = state.clone();
    let recv_room = room.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(ClientMsg::Move { x, y, waving, circle }) = serde_json::from_str(&text) else {
                continue;
            };
            handle_move(&recv_state, &recv_room, id, x, y, waving, circle);
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    {
        let mut rooms = state.rooms.lock().unwrap();
        if let Some(r) = rooms.get_mut(&room) {
            r.users.remove(&id);
            let _ = r.tx.send(encode(&ServerMsg::Bye { id }));
            if r.users.is_empty() {
                rooms.remove(&room);
            }
        }
    }
    state.connections.fetch_sub(1, Ordering::Relaxed);
}

/// A position someone could really be at, or off the page.
fn valid(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && (x.abs() < MAX_COORD && y.abs() < MAX_COORD || x <= -1e8)
}

fn handle_move(
    state: &AppState,
    room: &str,
    id: u64,
    x: f64,
    y: f64,
    waving: bool,
    circle: Option<Circle>,
) {
    if !valid(x, y) || circle.is_some_and(|c| !valid(c.x, c.y) || !(0.0..1000.0).contains(&c.r)) {
        return;
    }
    let now = Instant::now();
    let mut rooms = state.rooms.lock().unwrap();
    let Some(room) = rooms.get_mut(room) else { return };
    let Some(me) = room.users.get_mut(&id) else { return };
    me.x = x;
    me.y = y;
    me.waving = waving;
    me.circle = circle;
    let color = me.color;
    let _ = room.tx.send(encode(&ServerMsg::Cursor { id, x, y, waving, circle, color }));

    // The server decides when two people meet, so everyone sees the same moment.
    try_five(room, id, now);
    try_hug(room, id, now);
}

/// Two waving hands close together high five.
fn try_five(room: &mut Room, id: u64, now: Instant) {
    let users = &mut room.users;
    let (x, y) = (users[&id].x, users[&id].y);
    if !users[&id].can_five(now) {
        return;
    }
    let partner = users
        .iter()
        .filter(|&(&uid, u)| uid != id && u.can_five(now))
        .map(|(&uid, u)| (uid, (u.x - x).hypot(u.y - y)))
        .filter(|&(_, d)| d < FIVE_DISTANCE)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(uid, _)| uid);

    if let Some(other) = partner {
        let (ox, oy) = (users[&other].x, users[&other].y);
        for uid in [id, other] {
            users.get_mut(&uid).unwrap().last_five = Some(now);
        }
        let (mx, my) = ((x + ox) / 2.0, (y + oy) / 2.0);
        let _ = room.tx.send(encode(&ServerMsg::Five { a: id, b: other, x: mx, y: my }));
    }
}

/// Two people circling around the same spot hug.
fn try_hug(room: &mut Room, id: u64, now: Instant) {
    let users = &mut room.users;
    let Some(mine) = users[&id].hug_circle(now) else { return };
    let partner = users
        .iter()
        .filter(|&(&uid, _)| uid != id)
        .filter_map(|(&uid, u)| u.hug_circle(now).map(|c| (uid, c)))
        .map(|(uid, c)| (uid, c, (c.x - mine.x).hypot(c.y - mine.y)))
        .filter(|&(_, _, d)| d < HUG_DISTANCE)
        .min_by(|a, b| a.2.total_cmp(&b.2));

    if let Some((other, theirs, _)) = partner {
        for uid in [id, other] {
            users.get_mut(&uid).unwrap().last_hug = Some(now);
        }
        let (mx, my) = ((mine.x + theirs.x) / 2.0, (mine.y + theirs.y) / 2.0);
        let _ = room.tx.send(encode(&ServerMsg::Hug { a: id, b: other, x: mx, y: my }));
    }
}
