from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
import yfinance as yf
from datetime import datetime, timedelta
import threading
import time
import json

app = Flask(__name__, static_folder='static')
CORS(app)

# Cache for BTC data
cache = {
    'current': None,
    'history_1d': None,
    'history_5d': None,
    'history_1mo': None,
    'history_3mo': None,
    'history_1y': None,
    'last_update': None,
    'stats': None,
}

def fetch_btc_data():
    """Fetch BTC data from yfinance."""
    try:
        btc = yf.Ticker("BTC-USD")

        # Current info
        info = btc.info
        current_price = info.get('regularMarketPrice', info.get('previousClose', 0))
        prev_close = info.get('previousClose', info.get('regularMarketPreviousClose', 0))
        market_cap = info.get('marketCap', 0)
        volume_24h = info.get('volume24Hr', info.get('regularMarketVolume', 0))
        day_high = info.get('dayHigh', info.get('regularMarketDayHigh', 0))
        day_low = info.get('dayLow', info.get('regularMarketDayLow', 0))
        fifty_two_high = info.get('fiftyTwoWeekHigh', 0)
        fifty_two_low = info.get('fiftyTwoWeekLow', 0)

        change = current_price - prev_close if prev_close else 0
        change_pct = (change / prev_close * 100) if prev_close else 0

        cache['current'] = {
            'price': round(current_price, 2),
            'change': round(change, 2),
            'change_pct': round(change_pct, 2),
            'market_cap': market_cap,
            'volume_24h': volume_24h,
            'day_high': round(day_high, 2),
            'day_low': round(day_low, 2),
            'fifty_two_high': round(fifty_two_high, 2),
            'fifty_two_low': round(fifty_two_low, 2),
            'prev_close': round(prev_close, 2),
        }

        # Historical data for different periods
        periods = {
            '1d': ('1d', '5m'),
            '5d': ('5d', '15m'),
            '1mo': ('1mo', '1h'),
            '3mo': ('3mo', '1d'),
            '1y': ('1y', '1d'),
        }

        for key, (period, interval) in periods.items():
            try:
                hist = btc.history(period=period, interval=interval)
                data_points = []
                for idx, row in hist.iterrows():
                    ts = int(idx.timestamp() * 1000)
                    data_points.append({
                        'time': ts,
                        'open': round(row['Open'], 2),
                        'high': round(row['High'], 2),
                        'low': round(row['Low'], 2),
                        'close': round(row['Close'], 2),
                        'volume': int(row['Volume']),
                    })
                cache[f'history_{key}'] = data_points
            except Exception as e:
                print(f"Error fetching {key} history: {e}")

        # Compute additional stats
        if cache['history_1mo']:
            prices_1mo = [p['close'] for p in cache['history_1mo']]
            if len(prices_1mo) > 1:
                mo_change = ((prices_1mo[-1] - prices_1mo[0]) / prices_1mo[0]) * 100
            else:
                mo_change = 0
        else:
            mo_change = 0

        if cache['history_1y']:
            prices_1y = [p['close'] for p in cache['history_1y']]
            if len(prices_1y) > 1:
                yr_change = ((prices_1y[-1] - prices_1y[0]) / prices_1y[0]) * 100
            else:
                yr_change = 0
        else:
            yr_change = 0

        cache['stats'] = {
            'month_change_pct': round(mo_change, 2),
            'year_change_pct': round(yr_change, 2),
        }

        cache['last_update'] = datetime.now().isoformat()
        print(f"[{cache['last_update']}] BTC data updated: ${current_price:,.2f}")

    except Exception as e:
        print(f"Error fetching BTC data: {e}")

def background_updater():
    """Background thread to update data periodically."""
    while True:
        fetch_btc_data()
        time.sleep(30)  # Update every 30 seconds

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

@app.route('/api/current')
def api_current():
    if cache['current'] is None:
        return jsonify({'error': 'Data not yet loaded'}), 503
    return jsonify({
        'current': cache['current'],
        'stats': cache['stats'],
        'last_update': cache['last_update'],
    })

@app.route('/api/history/<period>')
def api_history(period):
    key = f'history_{period}'
    if key not in cache or cache[key] is None:
        return jsonify({'error': f'No data for period {period}'}), 404
    return jsonify({
        'period': period,
        'data': cache[key],
        'last_update': cache['last_update'],
    })

if __name__ == '__main__':
    # Start background data fetcher
    updater = threading.Thread(target=background_updater, daemon=True)
    updater.start()

    # Give it a moment to fetch initial data
    print("Fetching initial BTC data...")
    time.sleep(2)

    app.run(host='0.0.0.0', port=3003, debug=False)
