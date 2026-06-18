#!/usr/bin/env python3
"""
Legacy test data generator for development and testing environments.
Generates realistic-looking market data, orders, trades, and user data
for use in development and staging environments where real data cannot
be used due to compliance requirements.

The data generator uses seeded random number generation to produce
deterministic output for reproducible test scenarios. Change the seed
to generate different datasets.

WARNING: The generated data is NOT suitable for production use. It does
NOT follow real market distributions, correlation patterns, or regulatory
requirements. Using this data for performance testing will produce
misleading results because the data distribution is uniform rather than
following the power-law distributions seen in real markets.
"""

import argparse
import csv
import json
import math
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------

INSTRUMENTS = [
    {"symbol": "BTC/USD", "base": "BTC", "quote": "USD", "type": "crypto",
     "tick_size": 0.01, "lot_size": 0.0001, "price": 50000.0, "vol": 0.5},
    {"symbol": "ETH/USD", "base": "ETH", "quote": "USD", "type": "crypto",
     "tick_size": 0.01, "lot_size": 0.001, "price": 3000.0, "vol": 5.0},
    {"symbol": "SOL/USD", "base": "SOL", "quote": "USD", "type": "crypto",
     "tick_size": 0.001, "lot_size": 0.01, "price": 120.0, "vol": 50.0},
    {"symbol": "AVAX/USD", "base": "AVAX", "quote": "USD", "type": "crypto",
     "tick_size": 0.001, "lot_size": 0.01, "price": 35.0, "vol": 100.0},
    {"symbol": "LINK/USD", "base": "LINK", "quote": "USD", "type": "crypto",
     "tick_size": 0.001, "lot_size": 0.1, "price": 15.0, "vol": 200.0},
    {"symbol": "AAPL", "base": "AAPL", "quote": "USD", "type": "stock",
     "tick_size": 0.01, "lot_size": 1, "price": 180.0, "vol": 1000.0},
    {"symbol": "GOOGL", "base": "GOOGL", "quote": "USD", "type": "stock",
     "tick_size": 0.01, "lot_size": 1, "price": 140.0, "vol": 800.0},
    {"symbol": "MSFT", "base": "MSFT", "quote": "USD", "type": "stock",
     "tick_size": 0.01, "lot_size": 1, "price": 380.0, "vol": 500.0},
    {"symbol": "TSLA", "base": "TSLA", "quote": "USD", "type": "stock",
     "tick_size": 0.01, "lot_size": 1, "price": 240.0, "vol": 2000.0},
    {"symbol": "AMZN", "base": "AMZN", "quote": "USD", "type": "stock",
     "tick_size": 0.01, "lot_size": 1, "price": 150.0, "vol": 1200.0},
]

ORDER_SIDES = ["buy", "sell"]
ORDER_TYPES = ["market", "limit", "stop", "stop_limit"]
ORDER_STATUSES = ["new", "filled", "partially_filled", "cancelled", "rejected", "expired"]
TIME_IN_FORCE = ["gtc", "ioc", "fok", "day"]
DEFAULT_BASE_TIME_MS = 1704067200000  # 2024-01-01T00:00:00Z
MAX_RANDOM_SEED = 2**32 - 1

FIRST_NAMES = ["Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Hank",
               "Ivy", "Jack", "Kate", "Leo", "Mia", "Noah", "Olivia", "Paul",
               "Quinn", "Rose", "Sam", "Tina", "Uma", "Victor", "Wendy", "Xander",
               "Yuki", "Zara", "Aiden", "Bella", "Carlos", "Daisy", "Elijah", "Fiona"]

LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
              "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
              "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
              "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark",
              "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
              "Wright", "Scott", "Torres", "Hill", "Green", "Adams", "Baker", "Nelson",
              "Carter", "Mitchell", "Roberts", "Turner", "Phillips", "Campbell"]

DOMAINS = ["example.com", "test.org", "demo.net", "sample.io", "mock.dev",
           "fictitious.co", "imaginary.app", "pretend.tech", "dummy.biz",
           "simulated.com", "testmail.com", "inbox.test"]

def gaussian_random(mean: float, stddev: float, rng: random.Random) -> float:
    return rng.gauss(mean, stddev)

def clamp(value: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, value))

def round_to_tick(value: float, tick_size: float) -> float:
    return round(value / tick_size) * tick_size

def random_phone(rng: random.Random) -> str:
    return f"+1-{rng.randint(200, 999)}-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}"

def random_email(first: str, last: str, rng: random.Random) -> str:
    domain = rng.choice(DOMAINS)
    pattern = rng.choice([
        f"{first.lower()}.{last.lower()}",
        f"{first.lower()}{last.lower()}",
        f"{first[0].lower()}{last.lower()}",
        f"{last.lower()}.{first.lower()}",
        f"{first.lower()}{rng.randint(1, 999)}",
    ])
    return f"{pattern}@{domain}"

def random_datetime(rng: random.Random, start_year: int = 2023, end_year: int = 2024) -> datetime:
    start = datetime(start_year, 1, 1, tzinfo=timezone.utc)
    end = datetime(end_year, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
    delta = end - start
    return start + timedelta(seconds=rng.randint(0, int(delta.total_seconds())))


class DataGenerator:
    def __init__(self, seed: int, base_time_ms: int = DEFAULT_BASE_TIME_MS):
        self.seed = seed
        self.random = random.Random(seed)
        self.base_time_ms = base_time_ms
        self.instruments = INSTRUMENTS
        self.users: List[Dict[str, Any]] = []
        self.orders: List[Dict[str, Any]] = []
        self.trades: List[Dict[str, Any]] = []
        self.ticks: Dict[str, List[Dict[str, Any]]] = {}
        self.user_counter = 0
        self.order_counter = 0
        self.trade_counter = 0

    def generate_users(self, count: int = 50) -> List[Dict[str, Any]]:
        self.users = []
        for _ in range(count):
            self.user_counter += 1
            first = self.random.choice(FIRST_NAMES)
            last = self.random.choice(LAST_NAMES)
            user = {
                "id": f"user_{self.user_counter:04d}",
                "email": random_email(first, last, self.random),
                "name": f"{first} {last}",
                "role": self.random.choice(["trader", "trader", "trader", "admin",
                                            "analyst", "viewer"]),
                "status": self.random.choice(["active", "active", "active", "active", "inactive"]),
                "mfa_enabled": self.random.random() < 0.3,
                "email_verified": self.random.random() < 0.95,
                "created_at": random_datetime(self.random).isoformat(),
                "last_login": random_datetime(self.random, 2024, 2024).isoformat(),
                "phone": random_phone(self.random),
                "preferences": {
                    "theme": self.random.choice(["dark", "light"]),
                    "language": "en",
                    "timezone": "America/New_York",
                    "notifications": {
                        "email": True,
                        "push": self.random.random() < 0.5,
                    },
                },
            }
            self.users.append(user)
        return self.users

    def generate_orders(self, count: int = 200) -> List[Dict[str, Any]]:
        if not self.users:
            self.generate_users(20)

        self.orders = []
        for _ in range(count):
            self.order_counter += 1
            instrument = self.random.choice(self.instruments)
            user = self.random.choice(self.users)
            side = self.random.choice(ORDER_SIDES)
            order_type = self.random.choice(ORDER_TYPES)
            price = instrument["price"] * (1 + self.random.uniform(-0.05, 0.05))
            price = round_to_tick(price, instrument["tick_size"])
            quantity = round_to_tick(
                self.random.expovariate(1.0 / instrument["vol"]),
                instrument["lot_size"]
            )

            order = {
                "id": f"ord_{self.order_counter:06d}",
                "client_order_id": f"client_{self.order_counter:06d}",
                "user_id": user["id"],
                "instrument": instrument["symbol"],
                "side": side,
                "type": order_type,
                "price": price if order_type != "market" else None,
                "quantity": quantity,
                "time_in_force": self.random.choice(TIME_IN_FORCE),
                "status": self.random.choice(ORDER_STATUSES),
                "filled_quantity": 0,
                "avg_fill_price": None,
                "created_at": random_datetime(self.random).isoformat(),
                "updated_at": random_datetime(self.random, 2024, 2024).isoformat(),
            }
            self.orders.append(order)

        return self.orders

    def generate_trades(self, count: int = 500) -> List[Dict[str, Any]]:
        if not self.users:
            self.generate_users(20)

        self.trades = []
        for _ in range(count):
            self.trade_counter += 1
            instrument = self.random.choice(self.instruments)
            side = self.random.choice(ORDER_SIDES)
            price = instrument["price"] * (1 + self.random.uniform(-0.02, 0.02))
            price = round_to_tick(price, instrument["tick_size"])
            quantity = round_to_tick(
                self.random.expovariate(1.0 / instrument["vol"]),
                instrument["lot_size"]
            )

            trade = {
                "id": f"trade_{self.trade_counter:06d}",
                "instrument": instrument["symbol"],
                "price": price,
                "quantity": quantity,
                "total": round(price * quantity, 2),
                "side": side,
                "timestamp": random_datetime(self.random, 2024, 2024).isoformat(),
                "buyer": self.random.choice(self.users)["id"],
                "seller": self.random.choice(self.users)["id"],
                "buyer_fee": round(price * quantity * 0.001, 2),
                "seller_fee": round(price * quantity * 0.001, 2),
            }
            self.trades.append(trade)

        return self.trades

    def generate_ticks(self, instrument_symbol: str, count: int = 1000) -> List[Dict[str, Any]]:
        instrument = next(i for i in self.instruments if i["symbol"] == instrument_symbol)
        ticks = []
        price = instrument["price"]

        for i in range(count):
            change = price * self.random.gauss(0, 0.002)
            price = price + change
            price = round_to_tick(price, instrument["tick_size"])
            price = max(price, instrument["tick_size"])

            tick = {
                "instrument": instrument_symbol,
                "price": price,
                "bid": round_to_tick(price - instrument["tick_size"] * self.random.randint(1, 5),
                                    instrument["tick_size"]),
                "ask": round_to_tick(price + instrument["tick_size"] * self.random.randint(1, 5),
                                    instrument["tick_size"]),
                "volume": round(self.random.expovariate(1.0 / instrument["vol"]), 4),
                "timestamp": self.base_time_ms - (count - i) * 1000,
            }
            ticks.append(tick)

        self.ticks[instrument_symbol] = ticks
        return ticks

    def generate_candles(self, instrument_symbol: str, interval_minutes: int = 60,
                         count: int = 500) -> List[Dict[str, Any]]:
        instrument = next(i for i in self.instruments if i["symbol"] == instrument_symbol)
        candles = []
        price = instrument["price"]
        now = self.base_time_ms
        interval_ms = interval_minutes * 60 * 1000

        for i in range(count):
            open_price = price
            high_price = open_price * (1 + abs(self.random.gauss(0, 0.01)))
            low_price = open_price * (1 - abs(self.random.gauss(0, 0.01)))
            close_price = self.random.uniform(low_price, high_price)
            price = close_price

            candle = {
                "instrument": instrument_symbol,
                "time": now - (count - i) * interval_ms,
                "open": round(open_price, 2),
                "high": round(high_price, 2),
                "low": round(low_price, 2),
                "close": round(close_price, 2),
                "volume": round(self.random.expovariate(0.001), 2),
            }
            candles.append(candle)

        return candles

    def export_json(self, filepath: str, data: Any):
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2, default=str)
        print(f"Exported {filepath} ({os.path.getsize(filepath)} bytes)")

    def export_csv(self, filepath: str, data: List[Dict], fieldnames: Optional[List[str]] = None):
        if not data:
            print(f"No data to export for {filepath}")
            return
        fn = fieldnames or list(data[0].keys())
        with open(filepath, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fn, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(data)
        print(f"Exported {filepath} ({os.path.getsize(filepath)} bytes, {len(data)} rows)")


def parse_args():
    parser = argparse.ArgumentParser(description="Test data generator")
    parser.add_argument("--output-dir", "-o", default="./test_data", help="Output directory")
    parser.add_argument("--seed", type=int, default=None, help="Random seed; generated randomly when omitted")
    parser.add_argument("--print-seed", action="store_true", help="Print the generated seed for reproducibility")
    parser.add_argument("--users", type=int, default=50, help="Number of users to generate")
    parser.add_argument("--orders", type=int, default=200, help="Number of orders to generate")
    parser.add_argument("--trades", type=int, default=500, help="Number of trades to generate")
    parser.add_argument("--ticks", type=int, default=1000, help="Number of ticks per instrument")
    parser.add_argument("--candles", type=int, default=500, help="Number of candles per instrument")
    parser.add_argument("--json", action="store_true", help="Export as JSON")
    parser.add_argument("--csv", action="store_true", help="Export as CSV")
    parser.add_argument("--format", choices=["json", "csv", "both"], default="json", help="Output format")
    return parser.parse_args()


def resolve_seed(seed: Optional[int]) -> int:
    if seed is not None:
        return seed
    return random.SystemRandom().randint(0, MAX_RANDOM_SEED)


def output_format(args: argparse.Namespace) -> str:
    if args.json and args.csv:
        return "both"
    if args.json:
        return "json"
    if args.csv:
        return "csv"
    return args.format


def generation_metadata(args: argparse.Namespace, seed: int) -> Dict[str, Any]:
    return {
        "seed": seed,
        "base_time_ms": DEFAULT_BASE_TIME_MS,
        "format": output_format(args),
        "counts": {
            "users": args.users,
            "orders": args.orders,
            "trades": args.trades,
            "ticks_per_instrument": args.ticks,
            "candles_per_instrument_interval": args.candles,
            "instruments": len(INSTRUMENTS),
        },
    }


def main():
    args = parse_args()
    seed = resolve_seed(args.seed)
    gen = DataGenerator(seed)

    os.makedirs(args.output_dir, exist_ok=True)

    if args.seed is None and args.print_seed:
        print(f"Generated seed: {seed}")
    print(f"Generating test data with seed {seed}...")

    # Generate users
    users = gen.generate_users(args.users)
    print(f"  Users: {len(users)}")

    # Generate orders
    orders = gen.generate_orders(args.orders)
    print(f"  Orders: {len(orders)}")

    # Generate trades
    trades = gen.generate_trades(args.trades)
    print(f"  Trades: {len(trades)}")

    # Generate ticks for each instrument
    all_ticks = {}
    for inst in gen.instruments:
        ticks = gen.generate_ticks(inst["symbol"], args.ticks)
        all_ticks[inst["symbol"]] = ticks
        print(f"  Ticks ({inst['symbol']}): {len(ticks)}")

    # Generate candles for each instrument
    all_candles = {}
    for inst in gen.instruments:
        for interval in [1, 5, 15, 60, 240, 1440]:
            candles = gen.generate_candles(inst["symbol"], interval, args.candles)
            key = f"{inst['symbol']}_{interval}min"
            all_candles[key] = candles

    fmt = output_format(args)

    # Export
    gen.export_json(os.path.join(args.output_dir, "metadata.json"), generation_metadata(args, seed))

    if fmt in ("json", "both"):
        gen.export_json(os.path.join(args.output_dir, "users.json"), users)
        gen.export_json(os.path.join(args.output_dir, "orders.json"), orders)
        gen.export_json(os.path.join(args.output_dir, "trades.json"), trades)
        gen.export_json(os.path.join(args.output_dir, "ticks.json"), all_ticks)
        gen.export_json(os.path.join(args.output_dir, "candles.json"), all_candles)
        gen.export_json(os.path.join(args.output_dir, "instruments.json"), gen.instruments)

    if fmt in ("csv", "both"):
        gen.export_csv(os.path.join(args.output_dir, "users.csv"), users)
        gen.export_csv(os.path.join(args.output_dir, "orders.csv"), orders)
        gen.export_csv(os.path.join(args.output_dir, "trades.csv"), trades)

    print(f"\nAll data generated in {args.output_dir}/")


if __name__ == "__main__":
    main()
